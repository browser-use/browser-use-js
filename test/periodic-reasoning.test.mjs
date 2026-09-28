import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeriodicReasoning } from '../eval/periodic-reasoning.mjs';
import { auditedStream } from '../eval/audit.mjs';
import { parseOptions } from '../eval/run.mjs';
import { runAgent } from '../dist/agent.js';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
const start = { type: 'turn_start' };
const end = (stopReason = 'toolUse') => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason },
});
const payload = () => ({
  model: 'gpt-6-luna',
  reasoning: { effort: 'low', summary: 'auto' },
  tools: [{ name: 'javascript' }],
  input: [],
});

test('policy is opt-in and rejects invalid settings', () => {
  assert.equal(createPeriodicReasoning(undefined, 'medium'), undefined);
  assert.throws(() => createPeriodicReasoning('other', 'low'));
  assert.throws(() =>
    parseOptions({ periodic_reasoning: 'low-high-every-10', reasoning_effort: 'medium' }),
  );
  assert.equal(
    parseOptions({ periodic_reasoning: 'low-high-every-10', reasoning_effort: 'low' })
      .periodic_reasoning,
    'low-high-every-10',
  );
});
test('only reasoning effort changes, including turns 9/10/11/20', () => {
  const schedule = createPeriodicReasoning('low-high-every-10', 'low');
  for (let i = 1; i <= 21; i++) {
    schedule.onEvent(start);
    const body = payload(),
      before = structuredClone(body);
    const r = schedule.apply(body);
    assert.equal(r.logical_main_turn, i);
    assert.equal(body.reasoning.effort, i % 10 === 0 ? 'high' : 'low');
    before.reasoning.effort = body.reasoning.effort;
    assert.deepEqual(body, before);
    schedule.onEvent(end());
  }
});
test('retry of tenth turn keeps high; repeated payload callbacks do not advance', () => {
  const s = createPeriodicReasoning('low-high-every-10', 'low');
  for (let i = 1; i <= 10; i++) {
    s.onEvent(start);
    s.apply(payload());
    s.onEvent(end(i === 10 ? 'error' : 'toolUse'));
  }
  s.onEvent(start);
  for (let i = 0; i < 2; i++)
    assert.deepEqual(s.apply(payload()), {
      policy: 'low-high-every-10',
      event_turn: 11,
      logical_main_turn: 10,
      attempt_in_turn: 2,
      base_effort: 'low',
      applied_effort: 'high',
    });
  s.onEvent(end());
  s.onEvent(start);
  assert.equal(s.apply(payload()).applied_effort, 'low');
});
test('fails closed on missing events, wrong model or base effort', () => {
  const s = createPeriodicReasoning('low-high-every-10', 'low');
  assert.throws(() => s.apply(payload()), /turn_start/);
  s.onEvent(start);
  assert.throws(() => s.apply({ ...payload(), model: 'another-model' }), /Luna/);
  assert.throws(() => s.apply({ ...payload(), reasoning: { effort: 'medium' } }), /base low/);
});

function fakeStream(received, failureAtTen = false, finishAt = 21) {
  let calls = 0;
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const { getCurrentTools } = await import('@earendil-works/pi-ai');
      const tools = getCurrentTools(context.messages);
      const body = await options.onPayload(
        { ...payload(), tools: tools.map((t) => ({ name: t.name })), input: [] },
        model,
      );
      received.push(structuredClone(body));
      calls++;
      const failed = failureAtTen && calls === 10;
      const logical = calls - (failureAtTen && calls > 10 ? 1 : 0);
      const message = failed
        ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Connection error.' })
        : fauxAssistantMessage(
            fauxToolCall(
              logical === finishAt ? 'finish' : 'javascript',
              logical === finishAt ? { result: 'done' } : { code: 'ok' },
            ),
            { stopReason: 'toolUse' },
          );
      if (failed) stream.push({ type: 'error', reason: 'error', error: message });
      else stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end();
    })().catch((e) => {
      stream.push({
        type: 'error',
        reason: 'error',
        error: fauxAssistantMessage('', { stopReason: 'error', errorMessage: e.message }),
      });
      stream.end();
    });
    return stream;
  };
}
for (const failure of [false, true])
  test('real Pi runtime event order and retry integration ' + failure, async () => {
    const schedule = createPeriodicReasoning('low-high-every-10', 'low');
    const received = [],
      records = [],
      pending = [];
    let actions = 0;
    const runtime = {
      beginRun() {},
      async execute() {
        actions++;
        return { text: 'observed', images: [] };
      },
    };
    const model = {
      id: 'gpt-6-luna',
      api: 'openai-responses',
      provider: 'openai',
      name: 'Luna',
      reasoning: true,
      input: ['text'],
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      contextWindow: 1050000,
      maxTokens: 128000,
    };
    const run = await runAgent(
      runtime,
      model,
      {
        model: 'gpt-6-luna',
        reasoning: 'low',
        mode: 'ultrafast',
        streamFn: auditedStream(
          fakeStream(received, failure),
          records,
          pending,
          'priority',
          schedule,
        ),
      },
      '/tmp/fake-periodic-workspace',
      'Check observed facts',
      Type.String(),
      {
        maxSteps: 100,
        timeoutMs: 60000,
        compaction: false,
        maxContextChars: 800000,
        onEvent: (e) => schedule.onEvent(e),
      },
    );
    await Promise.all(pending);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.providerRetries, failure ? 1 : 0);
    assert.equal(actions, 20);
    assert.equal(records.length, failure ? 22 : 21);
    assert.deepEqual(
      records.map((r) => r.periodic_reasoning.logical_main_turn),
      failure
        ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
        : Array.from({ length: 21 }, (_, i) => i + 1),
    );
    for (const [i, r] of records.entries()) {
      assert.equal(
        received[i].reasoning.effort,
        r.periodic_reasoning.logical_main_turn % 10 === 0 ? 'high' : 'low',
      );
      assert.equal(received[i].service_tier, 'priority');
    }
  });
test('auxiliary payload stays low and does not consume a main turn', async () => {
  const s = createPeriodicReasoning('low-high-every-10', 'low');
  s.onEvent(start);
  const records = [],
    pending = [],
    bodies = [];
  const underlying = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void options.onPayload({ ...payload(), tools: [] }, model).then((body) => {
      bodies.push(body);
      stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('summary') });
      stream.end();
    });
    return stream;
  };
  const wrapped = auditedStream(underlying, records, pending, 'priority', s);
  wrapped({ id: 'gpt-6-luna' }, { messages: [] }, {});
  await Promise.all(pending);
  assert.equal(bodies[0].reasoning.effort, 'low');
  assert.equal(records[0].call_kind, 'auxiliary');
  assert.equal(records[0].periodic_reasoning, undefined);
  assert.equal(s.apply(payload()).logical_main_turn, 1);
});
test('finished before tenth turn gets no high turn', () => {
  const s = createPeriodicReasoning('low-high-every-10', 'low');
  for (let i = 1; i <= 9; i++) {
    s.onEvent(start);
    assert.equal(s.apply(payload()).applied_effort, 'low');
    s.onEvent(end(i === 9 ? 'stop' : 'toolUse'));
  }
});

test('real SDK 0.87.1 serializes high on tenth turn and priority on intercepted HTTP', async () => {
  const { streamSimple } =
    await import('../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js');
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const s = createPeriodicReasoning('low-high-every-10', 'low');
  for (let i = 1; i < 10; i++) {
    s.onEvent(start);
    s.onEvent(end());
  }
  s.onEvent(start);
  const bodies = [],
    records = [],
    pending = [];
  const model = {
    id: 'gpt-6-luna',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://example.invalid/v1',
    name: 'Luna',
    reasoning: true,
    input: ['text'],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    contextWindow: 1050000,
    maxTokens: 128000,
  };
  const context = {
    messages: [
      { role: 'system', content: 'Test only', timestamp: 1 },
      { role: 'user', content: 'Test', timestamp: 2 },
    ],
    tools: [
      { name: 'javascript', description: 'test', parameters: Type.Object({ code: Type.String() }) },
    ],
  };
  // Agent declares the current tools in its transcript using the real 0.87.1 representation.
  const wrapped = auditedStream(
    (m, c, o) =>
      streamSimple(m, c, {
        ...o,
        apiKey: 'not-a-real-key',
        maxRetries: 0,
        fetch: async (url, init) => {
          bodies.push(JSON.parse(init?.body ?? (await url.clone().text())));
          return new Response(
            JSON.stringify({ error: { message: 'mock stop', type: 'invalid_request_error' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        },
      }),
    records,
    pending,
    'priority',
    s,
  );
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: 'Test',
      thinkingLevel: 'low',
      tools: [
        { ...context.tools[0], label: 'test', execute: async () => ({ content: [], details: {} }) },
      ],
    },
    streamFn: wrapped,
  });
  await agent.prompt('Test');
  await Promise.all(pending);
  assert.equal(bodies.length, 1, JSON.stringify({ records, ending: agent.state.messages.at(-1) }));
  assert.equal(bodies[0].model, 'gpt-6-luna');
  assert.equal(bodies[0].reasoning.effort, 'high');
  assert.equal(bodies[0].service_tier, 'priority');
  assert.equal(records[0].periodic_reasoning.logical_main_turn, 10);
});
