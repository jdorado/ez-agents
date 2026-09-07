# Local event sources

A plugin owns capture, authentication and eligibility. The relay owns execution.
Register through `ezenciel-agents-source --name NAME --socket /absolute/service.sock`;
inspect with `--list`, remove with `--name NAME --remove`. Registration pins the
paired owner, assigns a new binding ID and starts at the provider's current head.
Same-user plugins are trusted installed code; private Unix sockets are the boundary,
not a sandbox against other programs running as that user.

POST JSON `{ "command": "...", "args": {} }` to `/` over the Unix socket.
Return HTTP 200 with `{ "ok": true, "data": ... }`:

- `events-head`: `{cursor: <nonnegative integer>}`.
- `events`, args `{after: <cursor>}`: `{cursor, events}`. Advance over excluded
  events too. IDs must remain stable; return at most ten events in capture order.
- `events-check`, args `{ids: [<string IDs>]}`: `{events}` containing only those
  IDs still eligible now, with current canonical content.

Each event is `{id, conversationId, receivedAt, text}`. IDs are at most 100 ASCII
letters/digits/underscore/hyphen; conversation IDs at most 200 characters;
receivedAt is epoch milliseconds; text at most 16000 characters. Responses are
bounded to 256 KiB and three seconds. Plugin-specific policy stays in the plugin.

The host polls each second and waits for two seconds of quiet, ten seconds of
age, or ten events. It groups by conversation and persists the batch before
creating deterministic run IDs. Cursor acknowledgement follows durable run
creation. Crash replay reuses the batch and run IDs. This deduplicates queue
creation; it does not promise exactly-once external actions after executor failure.

Before starting queued work, recheck binding, owner and provider eligibility.
Unavailable sources keep work queued; removed subscriptions cancel empty runs.
No check can retract work already started. External observations use fresh executor
sessions and explicitly carry no owner-instruction or send authority. They share
the existing one-writer queue and secret whitelist. No provider SDK is imported.
