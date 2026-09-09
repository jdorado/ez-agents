# Authority boundaries

The relay pairs one verified Telegram owner before execution; foreign senders
and groups do not acquire execution rights. Replies use the run-bound source
chat. The core owns authority decisions across plugins; plugins provide provider
transport, authentication and operation receipts.

## External events

Registered events are durably recorded and deduplicated but blocked before
executor launch with `external-execution-unavailable`. Work status reports the
blocked count. These use the existing terminal `cancelled` status plus an
additive `blockReason` field, preserving state-schema-1 rollback readability.
Subscription permission does not grant permission to execute
incoming demands. Unsubscription still cancels queued events; blocked runs do
not retry automatically or prevent ordinary owner work.

This deliberately stops the earlier behavior of running external events in a
fresh session with the owner's workspace. Current adapters do not provide the
required private-read, tool and network isolation. Autonomous correspondence is
unavailable until an isolated runner and core-controlled tool access exist.
Plugin exposure declarations do not override this boundary.

The local executor and host transport both require an active core run belonging
to the paired owner. The host independently reads its bound control directory;
request-supplied origin flags cannot promote an external run. Missing, corrupt,
inactive and owner-mismatched records fail before spawning an executor.

## Supported trust scope

The host CLI runs as the trusted installing user. Its Markdown role, confirmation
tools, environment filtering and private state layout do not create adversarial
OS isolation. Owner runs can access the plugin manager and Docker administration.
Local host users can modify their own state; a run ID is not authentication
against them. Reading untrusted content during owner work still relies on the
executor's judgment and native protections. This change does not claim to solve
prompt injection inside owner-authorized work.

See [SECURITY.md](../../SECURITY.md) for supported security scope and
[Docker runtime](../docker-runtime.md) for the process/storage boundary.
