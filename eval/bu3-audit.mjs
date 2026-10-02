/** BU3 measurement-only transport observer; provider payloads and native SDK loop are preserved. */
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function nativeEffort(effort) {
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
    throw new Error('Unsupported BU3 effort');
  // Pi names disabled thinking `off`; its pinned Luna catalog sends literal `none`.
  return effort === 'none' ? 'off' : effort;
}

export function createAudit(workspace, fetchImpl = globalThis.fetch) {
  const rows = [];
  const results = new Set();
  let queue = Promise.resolve();
  let sealed = false;
  const save = () => {
    if (sealed) return queue;
    const value = JSON.stringify(rows, null, 2) + '\n';
    queue = queue.then(() => writeFile(join(workspace, 'model-http-attempts.json'), value));
    return queue;
  };
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses')
      throw new Error('Unexpected model endpoint');
    const body = await request.clone().json();
    const row = {
      attempt: rows.length + 1,
      started_unix_ms: Date.now(),
      model: body.model,
      effort: body.reasoning?.effort,
      max_output_tokens: body.max_output_tokens,
      status: 'pending',
      usage: null,
      response_id: null,
    };
    rows.push(row);
    await save();
    try {
      const response = await fetchImpl(request);
      row.http_status = response.status;
      row.status = 'response';
      await save();
      if (!response.ok) {
        let error;
        try {
          error = await response.clone().json();
        } catch {}
        row.error = error?.error
          ? { code: error.error.code, type: error.error.type, param: error.error.param }
          : null;
        row.finished_unix_ms = Date.now();
        await save();
        return response;
      }
      let pending = '';
      const decoder = new TextDecoder();
      const consume = (text) => {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.response?.usage) {
            row.usage = event.response.usage;
            row.response_id = event.response.id;
            row.response_model = event.response.model;
            row.response_status = event.response.status;
          }
          if (event.type === 'error') row.error = { code: event.code, type: event.type };
        }
      };
      const stream = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            consume(decoder.decode(chunk, { stream: true }));
            controller.enqueue(chunk);
          },
          async flush() {
            consume(decoder.decode() + '\n');
            row.finished_unix_ms = Date.now();
            row.status = 'stream_finished';
            await save();
          },
        }),
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      row.status = 'transport_error';
      row.error_type = error.name;
      row.finished_unix_ms = Date.now();
      await save();
      throw error;
    }
  };
  return {
    rows,
    fetch,
    recordSDK(value) {
      if (sealed) return queue;
      queue = queue.then(() =>
        appendFile(join(workspace, 'model-sdk-calls.jsonl'), JSON.stringify(value) + '\n'),
      );
      return queue;
    },
    trackResult(promise) {
      results.add(promise);
      promise.finally(() => results.delete(promise)).catch(() => {});
    },
    async flush({ close = false, timeoutMs = 1000 } = {}) {
      let timer;
      try {
        await Promise.race([
          Promise.all([...results]),
          new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await queue;
      await save();
      const pending = {
        pending_sdk_results: results.size,
        settlement_timeout_ms: timeoutMs,
        unknown_usage: results.size > 0,
      };
      if (close) sealed = true;
      await queue;
      await writeFile(
        join(workspace, 'model-sdk-pending.json'),
        JSON.stringify(pending, null, 2) + '\n',
      );
      return pending;
    },
  };
}

export function auditedStream(models, audit, workspace) {
  let calls = 0;
  return (model, context, settings = {}) => {
    const id = ++calls;
    if (
      model.id !== 'gpt-5.6-luna' ||
      model.provider !== 'openai' ||
      model.api !== 'openai-responses'
    )
      throw new Error('BU3 requires exact native Luna Responses model');
    const requested = settings.reasoning ?? 'off';
    const literal = requested === 'off' ? 'none' : requested;
    if (model.thinkingLevelMap?.[requested] !== literal)
      throw new Error('Effort would be aliased or unsupported');
    const cap = Math.min(settings.maxTokens ?? 32000, 32000);
    const stream = models.streamSimple(model, context, {
      ...settings,
      maxTokens: cap,
      fetch: audit.fetch,
      async onPayload(payload) {
        if (
          payload.model !== model.id ||
          payload.reasoning?.effort !== literal ||
          !(payload.max_output_tokens > 0 && payload.max_output_tokens <= cap)
        )
          throw new Error('Native wire model/effort/cap mismatch');
        await audit.recordSDK({
          call: id,
          phase: 'request',
          model: model.id,
          api: model.api,
          requested_effort: requested,
          wire_effort: literal,
          max_output_tokens: payload.max_output_tokens,
          time: Date.now(),
        });
      },
    });
    // Observe every SDK request, including compaction and retry calls, without consuming its event iterator.
    const receipt = stream
      .result()
      .then((message) =>
        audit.recordSDK({
          call: id,
          phase: 'result',
          model: message.model,
          provider: message.provider,
          stop_reason: message.stopReason,
          usage: message.usage,
          time: Date.now(),
        }),
      )
      .catch((error) =>
        audit.recordSDK({ call: id, phase: 'receipt_error', error_type: error.name }),
      );
    audit.trackResult(receipt);
    return stream;
  };
}
