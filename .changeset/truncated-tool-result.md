---
'@tanstack/ai': minor
---

A model answer with tool calls that stops at the output limit (finish reason `length`) can continue, and its cut tool calls never run.

- Behavior change: `chat()` never runs a tool call of an answer that stopped at the output limit. The input of such a call can be incomplete JSON. The call also asks for no approval, and the client does not run a client tool for it. Before, a call of a cut answer could run, for example when a provider-executed tool kept the call in the transcript, or when a later `chat()` call got that history.
- Each assistant message that `chat()` stores keeps the finish reason of its model call in `metadata.tanstack.finishReason`.
- When `chat()` stores a cut answer that keeps its tool calls, each call gets an error tool result with a default text. A history that has such a call with no result does not run it.
- New `chat({ truncatedToolResult })` option: a string, or a function that gets `{ toolCallId, toolName }`. When it is set, the answer keeps its tool calls, each call gets that text as its error result, and the model is called again. This counts as one iteration of the loop. The `RUN_FINISHED` event of that model call has the finish reason `tool_calls`, so the client keeps the stream open.

Migration: if your app needs the model to continue after a cut tool call, set `truncatedToolResult` to a text that tells the model to send the call again with the complete input. To find a cut answer on the server, read `metadata.tanstack.finishReason === 'length'` on the stored assistant message.
