// Pure dispatch of session_event payloads → chat-state mutations.
// Kept separate from app.js so the wiring is unit-testable without DOM.

import {
  applyDelta,
  applyTurnProgress,
  onAgentEnd,
  onAgentStart,
  onToolEnd,
  onToolStart,
} from "./chat-state.mjs";

export function dispatchSessionEvent(state, event) {
  switch (event?.type) {
    case "turn_step":
    case "turn_phase":
    case "turn_notice":
      applyTurnProgress(state, event.type, event);
      return;
    case "agent_start":
      onAgentStart(state);
      return;
    case "agent_end":
      onAgentEnd(state, event);
      return;
    case "message_start":
      if (event.message?.readyaiAutoContinue && state.progress) {
        state.progress.timeline.push({ type: 'text', text: '系統自動續跑', system: true });
      }
      return;
    case "message_update":
      applyDelta(state, event.assistantMessageEvent || {});
      return;
    case "tool_execution_start":
      onToolStart(state, event.toolName, event.args, event.toolCallId);
      return;
    case "tool_execution_end":
      onToolEnd(state, event.toolName, event.result, event.toolCallId);
      return;
    default:
      return;
  }
}
