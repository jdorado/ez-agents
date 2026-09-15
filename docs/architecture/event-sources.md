# Local event sources

A plugin owns capture, authentication and subscription filtering. The core owns
authority and execution; subscription filtering cannot grant permissions.
Register through `ezenciel-agents-source --name NAME --socket /absolute/service.sock`;
inspect with `--list`, remove with `--name NAME --remove`. Registration pins the
paired owner, assigns a new binding ID and starts at the provider's current head.
Registered plugins are trusted installed code. Private Unix sockets bind a local
transport, not an authorization claim from message content or an adversarial sandbox.

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
bounded to 256 KiB and three seconds. Provider capture/filtering stays in the plugin;
execution authority stays in the core.

The host polls each second and waits for two seconds of quiet, ten seconds of
age, or ten events. It groups by conversation and persists the batch before
creating deterministic run IDs. Cursor acknowledgement follows durable run
creation. Crash replay reuses the batch and run IDs. This deduplicates queue
creation; it does not promise exactly-once external actions after executor failure.

Before starting queued work, recheck binding, owner and provider eligibility.
Unavailable sources keep work queued; removed subscriptions cancel empty runs.
Events matching exactly one active core task launch its restricted fresh-session
runner; unmatched events are recorded as blocked (`external-execution-unavailable`)
with no executor launch. Neither borrows the owner workspace, session or tools.
Any-conversation tasks admit at most one outstanding run per conversation and
eight across the public source queue, with persisted limits of 60 conversations
and 60 replies per hour and 1,000 across a grant. The cumulative limit revokes
the grant. Owner work is preferred and preempts an active public run. Terminal
history retains the latest 100 runs per public grant; providers supporting
`releaseEvents` are told to discard terminal source events. The source cursor and
deterministic run IDs preserve replay. No provider SDK or provider-specific
authority is imported into core.
See [authority boundaries](authority-boundaries.md).
