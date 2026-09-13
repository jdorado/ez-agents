# Application input to the standard agent

An installed application can submit work to the ordinary Ez agent. Ez uses its
existing run queue, native executor, session store, cancellation and message
outbox. The application supplies domain tools and keeps its UI/content API; it
can remove its own model runner, continuation loop and engine authentication.
This is separate from the older outbound channel-backend integration.

## Install and authorize

Pair the ordinary agent's owner first. As the installing administrator, outside
an agent turn, generate a random 32-byte base64url token into a private file and
register it:

```sh
ezenciel-agents-application --id myapp --token-file /private/myapp-token
```

The application backend receives that token through its secret store. Core stores
only its SHA-256 digest, bound to this owner pairing. Revoke with `--id myapp
--revoke`; re-register to replace authority. Re-pairing also invalidates the grant.
Revocation blocks admission, results and delivery and stops an active app run on
the existing queue tick. `--list` exposes IDs, never tokens or hashes.

This grant lets a **trusted application backend act for the paired owner**. It is
not a multi-tenant filesystem sandbox. The application authenticates its users,
derives their allowed scope, and enforces domain tool permissions. Independent
owners or untrusted applications need separate agents/workspaces. Scoped sessions
separate conversation history; they share the ordinary agent's filesystem and
tool authority. Do not give this bearer token to browser JavaScript or models.

Enable the optional listener in the relay environment:

```dotenv
EZ_APPLICATION_PORT=8787
EZ_APPLICATION_HOST=0.0.0.0
```

The default bind address is loopback. In Docker, put the relay and backend on a
private shared network and use `http://<relay-service>:8787`; do not publish a host
port. Cross-host use requires HTTPS or an authenticated private tunnel. There is
no listener unless a port is configured. This mode cannot be combined with the
older channel-backend URL. Install core normally: its bin manifest makes the
application administration command available through the standard tools setup.

## Request and result

All endpoints require `Authorization: Bearer <token>`.

```text
POST /v1/runs
{"requestId":"job-123","scope":"principal:program","text":"Prepare our next lesson","context":{"reference":"lesson-1"}}

GET /v1/runs/<id>
POST /v1/runs/<id>/cancel
```

Submission returns HTTP 202; reads/cancellation return 200. Each response is:

```json
{"id":"r_app_...","scope":"principal:program","status":"queued","messages":[]}
```

Status is `queued`, `running`, `completed`, `failed` or `cancelled`. Messages are
`{id,text}` records sent by the native agent through the existing message CLI.
The backend polls and renders them; no raw native JSONL or Telegram messages are
exposed. A delivery receipt means durable availability in the application inbox,
not that a human read it. Failure adds a generic `error`; detailed logs remain
local to core. Cancellation uses the existing child termination boundary and may
return `running` until the process exits.

`requestId` and `scope` accept 1–200 ASCII letters, digits, `_:.-`. Text is at most
16,000 characters. Context is an optional JSON object (48 KiB); the complete HTTP
body is bounded to 64 KiB. Unknown input fields are rejected. Use a stable job ID:
retries with the same ID, scope and text return the original run and original
context, even if the caller supplies refreshed context. Changed scope/text is a
409 conflict. Persist the submitted context/capability for recovery, or poll the
original run; retries never grant replacement authority to an admitted run.

Context is opaque domain-tool data, not prompt text or an environment override.
The existing `ezenciel-agents-schedule context` exposes it as
`run.application.context` only to the current native run. Domain tools and their
filesystem mounts are installed using ordinary Ez plugin/runtime setup. No API
field selects a native session, working directory, process environment or owner.
This first version transports text only, without file delivery, reactions or
approval UI.

## Conversation continuity and migration

Each application binding plus scope gets an existing core session. Its first run
captures the selected engine/preset; later runs resume that same native session.
Application sessions are excluded from the Telegram session selector. Engines
that only resume an implicit latest session (`agy`) cannot serve isolated scopes.

Before cutting over an existing application, stop its old runner, copy its native
transcripts into the ordinary engine's private state, and import each authoritative
scope pointer as the administrator:

```sh
ezenciel-agents-application --id myapp --import-scope principal:program \
  --native-session NATIVE_SESSION_ID --cli codex
```

Do this before submitting work for that scope. Import does not copy transcripts,
change the model preset, or merge histories. Verify the next real native turn
recalls the intended history and the app renders its reply before removing the
old deployment. Keep exactly one executor owner throughout the cutover.
