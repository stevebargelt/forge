// FG-787: claude-code `--output-format stream-json --include-partial-messages`
// fixtures, shaped on a real container.stdout.log: one `assistant` event per
// content block (message.stop_reason null on each), the turn's stop_reason
// carried by a `stream_event` message_delta, tool results as `user` events, and a
// terminal `result` event. Sanitized: ids and text are synthetic.

const SESSION = "14c47d7c-0000-4000-8000-000000000000";

export function sInit(): string {
  return JSON.stringify({ type: "system", subtype: "init", cwd: "/project", session_id: SESSION, tools: ["Bash", "Monitor", "ScheduleWakeup", "ToolSearch"] });
}

export function sToolUse(id: string, name: string, input: Record<string, unknown>, parent: string | null = null): string {
  return JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5-5", id: `msg_${id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null, stop_sequence: null },
    parent_tool_use_id: parent, session_id: SESSION, uuid: `u-${id}`,
  });
}

export function sText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5-5", id: "msg_text", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null, stop_sequence: null },
    parent_tool_use_id: null, session_id: SESSION, uuid: "u-text",
  });
}

export function sToolResult(toolUseId: string, content: string, parent: string | null = null): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content }] },
    parent_tool_use_id: parent, session_id: SESSION, uuid: `r-${toolUseId}`,
  });
}

export function sStop(stopReason: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 2, output_tokens: 40 } },
    session_id: SESSION, parent_tool_use_id: null, uuid: `d-${stopReason}`,
  });
}

export function sResult(stopReason = "end_turn"): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 4, result: "The monitor will report when the suite finishes. Let me wait for the result.", stop_reason: stopReason, session_id: SESSION });
}

/** The FG-787 incident shape: run the suite in the background, arm a Monitor on
 *  its output, narrate "let me wait", end the turn. */
export function monitorThenEndTurnStream(): string {
  return [
    sInit(),
    sToolUse("toolu_bg", "Bash", { command: "npm run test:browser > /tmp/suite.log 2>&1", run_in_background: true }),
    sStop("tool_use"),
    sToolResult("toolu_bg", "Command running in background with ID: bash_1"),
    sToolUse("toolu_mon", "Monitor", { file: "/tmp/suite.log", pattern: "passed|failed" }),
    sStop("tool_use"),
    sToolResult("toolu_mon", "Monitor armed."),
    sText("The monitor will report when the suite finishes. Let me wait for the result."),
    sStop("end_turn"),
    sResult("end_turn"),
  ].join("\n");
}
