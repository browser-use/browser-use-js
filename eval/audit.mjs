// Measurement only: retain hashes/counts/usage, never prompts, image bytes, keys or headers.
import { createHash } from 'node:crypto';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function summarizeContext(messages = []) {
  return messages.map((message) => {
    const content = Array.isArray(message.content) ? message.content : [];
    const images = content.filter((part) => part.type === 'image');
    if (images.some((part) => part.data?.includes('[image bytes')))
      throw new Error('Redacted image cannot be hashed as original');
    return {
      role: message.role,
      key: message.toolCallId ?? null,
      hash: hash(message),
      estimated_tokens: estimateTokens(message),
      image_hashes: images.map((part) => hash([part.mimeType, part.data])),
      image_count: images.length,
    };
  });
}
export function contextDelta(previous, current) {
  let common = 0;
  while (
    common < previous.length &&
    common < current.length &&
    previous[common].hash === current[common].hash
  )
    common++;
  const byKey = new Map(current.filter((m) => m.key).map((m) => [m.key, m]));
  const evicted = previous.filter(
    (m) =>
      m.image_count && m.key && byKey.has(m.key) && byKey.get(m.key).image_count < m.image_count,
  );
  const byHash = new Map(current.map((m) => [m.hash, m]));
  const retained = previous
    .slice(common)
    .map((m) => (m.key ? byKey.get(m.key) : byHash.get(m.hash)))
    .filter(Boolean);
  return {
    common_prefix_messages: common,
    retained_prior_suffix_estimated_tokens: retained.reduce((n, m) => n + m.estimated_tokens, 0),
    prior_suffix_estimated_tokens: previous
      .slice(common)
      .reduce((n, m) => n + m.estimated_tokens, 0),
    unchanged_prefix_estimated_tokens: previous
      .slice(0, common)
      .reduce((n, m) => n + m.estimated_tokens, 0),
    removed_image_blocks_from_retained_messages: evicted.reduce(
      (n, m) => n + m.image_count - byKey.get(m.key).image_count,
      0,
    ),
    evicted_tool_call_ids: evicted.map((m) => m.key),
    removed_entire_image_messages: previous.filter(
      (m) => m.image_count && m.key && !byKey.has(m.key),
    ).length,
    estimate_note:
      'SDK estimateTokens, not provider tokenization or guaranteed cache eligibility. Prefix difference may include compaction or other changes.',
  };
}
export function auditedStream(streamFn, records, pending, serviceTier, periodicReasoning) {
  // Summary requests have their own prompt; keep them out of successive main-call deltas.
  let previousMain = [];
  return (model, context, options = {}) => {
    const messages = summarizeContext(context.messages);
    const record = {
      id: records.length + 1,
      model: model.id,
      started_at: new Date().toISOString(),
      started_ms: Date.now(),
      http: [],
      context: {
        message_count: messages.length,
        image_blocks: messages.reduce((n, m) => n + m.image_count, 0),
        image_messages: messages
          .filter((m) => m.image_count)
          .map((m) => ({ role: m.role, key: m.key, hashes: m.image_hashes })),
        estimated_tokens: messages.reduce((n, m) => n + m.estimated_tokens, 0),
      },
    };
    records.push(record);
    const request = options.fetch ?? globalThis.fetch;
    const stream = streamFn(model, context, {
      ...options,
      onPayload: async (payload, selected) => {
        const changed = await options.onPayload?.(payload, selected);
        const body = changed ?? payload;
        if (serviceTier) body.service_tier = serviceTier;
        const tools = (body.tools ?? []).map((t) => t.name);
        record.call_kind = tools.some((t) => ['javascript', 'finish', 'finish_from_js'].includes(t))
          ? 'main'
          : 'auxiliary';
        if (record.call_kind === 'main' && periodicReasoning)
          record.periodic_reasoning = periodicReasoning.apply(body);
        if (record.call_kind === 'main' && !record.history_delta) {
          record.history_delta = contextDelta(previousMain, messages);
          previousMain = messages;
        }
        record.request = {
          model: body.model,
          reasoning: body.reasoning?.effort,
          service_tier: body.service_tier,
          tools,
          input_chars: JSON.stringify(body.input ?? []).length,
          max_output_tokens: body.max_output_tokens,
          payload_input_sha256: hash(body.input ?? []),
          prompt_cache_key_present: !!body.prompt_cache_key,
          prompt_cache_mode: body.prompt_cache_mode ?? null,
        };
        return body;
      },
      fetch: async (...args) => {
        const http = { started_ms: Date.now() };
        record.http.push(http);
        try {
          const response = await request(...args);
          http.status = response.status;
          http.headers_ms = Date.now() - http.started_ms;
          return response;
        } catch (error) {
          http.error = error.name;
          http.headers_ms = Date.now() - http.started_ms;
          throw error;
        }
      },
    });
    pending.push(
      Promise.resolve(stream)
        .then((s) => s.result())
        .then(
          (message) => {
            record.duration_ms = Date.now() - record.started_ms;
            record.stop_reason = message.stopReason;
            record.usage = message.usage;
          },
          (error) => {
            record.duration_ms = Date.now() - record.started_ms;
            record.error = error.name;
          },
        ),
    );
    return stream;
  };
}
