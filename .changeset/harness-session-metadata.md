---
'@tanstack/ai-persistence': minor
'@tanstack/ai-harness': minor
---

Keep app data on a session, and keep the writes of several hosts.

- `host.sessions.update(harness, threadId, change)` changes the `title`, `pinned`, or `metadata` of a session entry from app code, with no session open. `change` is an object, or a function of the current entry. `POST sessions` takes `{ op: 'update', threadId, title?, pinned?, metadata? }`, and the client has `updateSession`. A client can write `metadata` only when the harness has a `metadataSchema` (else `403 not_exposed`).
- `defineHarness({ metadataSchema })` takes a Standard Schema (for example a zod object). It checks the metadata of each write and types it: `host.sessions.update`, the typed client, `session.entry()` and `session.updateEntry()`, and the turn hooks. A refused write throws `SessionMetadataError` (`400 invalid_metadata` over HTTP). A plugin can take the same schema with `definePlugin({ metadataSchema })`. Then `ctx.session.entry()` and `ctx.session.updateEntry()` are typed, and a harness whose metadata does not fit is a type error. Plugin `updateEntry` also takes a function of the current entry.
- `SessionIndexStore` can have `getVersioned` and `upsertIf` for compare-and-set. With them, a host runs its change again when another host wrote the entry first, so the usage of a turn does not remove a metadata change of the app. The memory store has both, and the conformance suite checks them.
- The user message of a wake turn (a background agent or job ended) has `metadata.harness.wake: true`. The session view does not show it after a reload.

Compatibility: `HarnessDefinition`, `HarnessConfig`, and `defineHarness` have a 4th type parameter, the metadata schema. A type that names `HarnessDefinition<A, B, C>` keeps working. A conditional type that infers from `HarnessDefinition<any, infer A, infer B>` needs a 4th `any`.
