---
'@tanstack/ai-pi-stream': minor
---

Add `@tanstack/ai-pi-stream`. It puts TanStack `useChat` in front of a pi agent (`@earendil-works/pi-agent-core`) on your server.

- `runPiAgent(await chatParamsFromRequest(request), { config, streamFn, tools })` runs the pi agent loop for a `useChat` request and streams AG-UI events.
- pi tools in `needsApproval` pause for a `useChat` approval. The client tools of `useChat` run in the browser.
- For a hand-run `agentLoop()`, use `fromPiAgentEvents` and `toPiMessages`.

Text, reasoning and redacted reasoning with signatures, tool calls and results with images, tool errors and progress, usage and cost, and errors reach the client. Image URLs, audio, video and documents sent to pi end the run with an error.
