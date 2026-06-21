---
id: FG-337
type: story
status: done
title: "runtime: capture final assistant message as result when a runtime completes cleanly but writes no result.json"
created: 2026-06-19
closed: 2026-06-21
---

**Found:** 2026-06-19, dogfooding pi on a free Groq model (FG-258). Two failure modes both reduce to free/weak-model tool-calling:
- tools allowed: `llama-3.3-70b-versatile` emitted a malformed tool call (`bash{...}` as the tool name) -> pi rejected `not in request.tools`.
- tools forbidden: the model replied in plain text but could not write `/task/result.json` (writing the file IS a tool call) -> forge failed the task "did not honor the output contract".
A capable model (`openai/gpt-oss-120b`) then completed cleanly WITH a valid result.json. So the result.json output contract implicitly assumes reliable structured tool-calling.

**Why it matters for #258:** provider-agnosticism's whole point is cheap/fast/local models (Groq/Ollama) for reds & triage. Those are exactly the models weakest at tool-calling, so the contract will keep biting as the epic moves toward the Run stage and local models (#268).

**Proposed (for discussion, not committed):** when a runtime exits cleanly (no crash/error) but writes no result.json, fall back to capturing the final assistant message as the task result (flagged as `contract: inferred`) rather than hard-failing. Keeps weak-model runs usable for non-structured tasks; structured consumers can still require a real result.json. Alternatively/additionally: a per-profile capability flag so forge only routes tool-requiring roles to tool-capable models.

Relates: #258, #268, #228.
