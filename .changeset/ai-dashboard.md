---
'@tanstack/ai-dashboard': minor
---

New package `@tanstack/ai-dashboard`: a self-hosted dashboard for harness sessions.

- `npx @tanstack/ai-dashboard` starts it (`startDashboard` in code).
- Agents dial out with `connectDashboard` from `@tanstack/ai-dashboard/connect`, pair with a one-time code, and get a revocable host token.
- The web app lists hosts and sessions, streams messages and tool calls, shows approval cards and plugin questions, and sends prompts, steers, and stops. It installs as a web app on a phone.
- Inputs for an offline host wait at the dashboard and reach it on reconnect.
- After a dashboard restart, a host with `onPairingCode` pairs again and gets a new token through `onToken`. Without it, `onError` gets the error.
- A host that sets `allowRemoteStart` gets an "Open a thread" form in its row.
