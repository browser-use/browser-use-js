// Evaluation-only schedule. The Pi runtime and model-visible prompts stay unchanged.
export function createPeriodicReasoning(policy, baseEffort) {
  if (policy === undefined) return undefined;
  if (policy !== 'low-high-every-10' || baseEffort !== 'low')
    throw new Error('periodic_reasoning requires low-high-every-10 and base low');
  let eventTurn = 0,
    logicalTurn = 0,
    attemptInTurn = 0,
    previousFailed = false;
  return {
    onEvent(event) {
      if (event.type === 'turn_start') {
        eventTurn++;
        if (!previousFailed) {
          logicalTurn++;
          attemptInTurn = 1;
        } else attemptInTurn++;
        previousFailed = false;
      }
      if (event.type === 'message_end' && event.message.role === 'assistant')
        previousFailed = ['error', 'aborted'].includes(event.message.stopReason);
    },
    apply(body) {
      if (logicalTurn < 1) throw new Error('Main payload before turn_start');
      if (body.model !== 'gpt-6-luna' || body.reasoning?.effort !== 'low')
        throw new Error('Periodic policy expects Luna with base low reasoning');
      const effort = logicalTurn % 10 === 0 ? 'high' : 'low';
      body.reasoning = { ...body.reasoning, effort };
      return {
        policy,
        event_turn: eventTurn,
        logical_main_turn: logicalTurn,
        attempt_in_turn: attemptInTurn,
        base_effort: baseEffort,
        applied_effort: effort,
      };
    },
  };
}
