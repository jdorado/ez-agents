# Application input to the standard agent

An installed application can submit work to the ordinary Ez agent. Ez uses its
existing run queue, native executor, session store, cancellation and message
outbox. The application supplies domain tools and keeps its UI/content API; it
can remove its own model runner, continuation loop and engine authentication.
This is separate from the older outbound channel-backend integration.

Run admission, status and inbox receipts include the immutable `preset` captured
for that run so an application can label delivered messages with the engine choice
that actually produced them.

## Shared runtime controls

Register with `--share-owner` (the existing `--share-telegram` spelling is an
alias) to grant access to the runtime's active conversation and standard AI
settings. This explicit grant works with or without a Telegram bot. It grants
control of the same active state Telegram uses when enabled; it is not a
scope-only permission. Ordinary application bindings cannot read or change it.

`GET /v1/control` returns the existing Ez AI presets, installed native model
catalog, active control-session ID and conversations visible through `/chats`.
Native engine session IDs and private application scopes are omitted. The token
stays in the authenticated application backend, never in browser code.

`POST /v1/control` accepts one action and the `expectedSession` returned by the
last read (null before a conversation exists):

| Action | Additional fields | Existing Ez operation |
| --- | --- | --- |
| `new` | None | `/new`, using the default AI |
| `switch` | `sessionId` from the visible conversation list | `/chats` selection |
| `select` | `presetId` from `ai.presets` | Select a saved AI |
| `model` | `cli`, optional `model` and `effort`, from `models` | Save/select the same native choice as `/ai` |

Engine changes start a fresh conversation through the same selection operation
as Telegram. A changed active conversation rejects a stale mutation; refresh
controls before another attempt. Model changes within one conversation retain
the ordinary last-selection-wins behavior. Already-admitted runs keep their
captured conversation and AI. Uncertain control responses require a fresh read,
not blind repetition of `/new`.

For private application conversations, `GET /v1/scope-control?scope=<encoded-scope>` returns
the same catalog and the current scope's public control ID and preset. The scope
is the application's original admission scope, resolved under its authenticated
binding. `POST` accepts `new`, `select` and `model` with that scope's
`expectedSession`. It does not require shared-control permission. Shared scopes
must use `/v1/control` instead.

A scope reset uses the configured default AI. A client change starts a fresh
private conversation; a model change within the same client retains it. Retired
private conversations stay hidden from `/chats`; admitted work can finish in its
original native session. Neither operation changes the shared active selection.
Control mutations are never marked retryable by the public client: read back
after uncertainty before deciding on another change.

Current HTTP gaps: rename/archive, scheduling
administration and shared-chat stop-all are not exposed here. Per-run application
cancellation remains available. The native agent can use the standard scheduler
from an application turn; its replies retain that channel binding.

## Install and authorize

An installation has one owner, independent of its channels. As the installing
administrator, outside an agent turn, generate a random 32-byte base64url token
into a private file and register the first channel with a verified opaque owner ID:

```sh
ezenciel-agents-application --owner-id verified-account --id web --token-file /private/web-token --share-owner
ezenciel-agents-application --id phone --token-file /private/phone-token --share-owner
```

The application backend receives that token through its secret store. Core stores
only its SHA-256 digest, bound to the installation owner. Channel IDs are arbitrary
labels, not a predefined provider list. The trusted adapter verifies its provider's
identity (for example Privy); a browser-supplied owner ID is never authentication.
For an existing Telegram owner, omit `--owner-id`: the new channel attaches to that
same owner. `GET /v1/registration` returns the owner ID and binding ID.
Revoke a channel with `--id web --revoke`. Rotate with `--id web --token-file
/private/new-token --rotate`: the binding ID, retries and native sessions remain
unchanged. Revoking the installation owner invalidates every channel.
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
GET /v1/runs
GET /v1/registration
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

Inside an active native application run, `ezenciel-agents-message history
--limit 8` reads delivered text from this same inbox for the run's immutable
application binding and scope, including earlier runs in that scope. It cannot
read another binding, scope, or Telegram chat. The Telegram numeric
`--message-id` filter is unavailable for application runs. This reads the same
bounded relay delivery state as the application inbox; both disappear on relay
restart and add no persistent message record.

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
This version transports text plus core approval requests, without file delivery
or reactions. Run snapshots include `approvals: [{id,prompt,state}]`. Render the
prompt verbatim and POST `{"decision":"approved"}` or
`{"decision":"denied"}` to `/v1/approvals/TASK_ID` with the same bearer
credential. Core binds the decision to the authenticated owner generation; the
application must not infer or auto-submit consent.

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
For an owner-chat channel registered with `--share-owner`, add `--share-owner`
to the import command to select that imported conversation as the owner's current
chat. Without it, the import remains scoped and does not switch owner chat.

## Reviewed deployment migration

The first upgrade adding the two optional application listener environment lines
changes `compose.yaml`. The existing updater deliberately rejects that runtime
shape change with “Runtime deployment changed; a separately reviewed migration is
required.” Keep this guard. Installation requires a separately reviewed deployment
migration before subsequent ordinary updates can use the new baseline.

The operator verifies the immutable archive's SHA-256, extracts it into a new
versioned package directory, copies `docker/pnpm-lock.yaml` to `pnpm-lock.yaml`,
and installs frozen dependencies **inside that package root**. Verify the new
application CLI and root-local `tsx` resolve. Build its runtime image without
stopping or changing the existing agent. Then the authorized deployment owner
switches the saved package/image binding using the standard host/update setup,
preserving the agent's existing workspace, control, native engine state, owner
pairing and plugin registry. Do not copy another agent's state or disable the
updater's deployment compatibility check.

For Docker applications, a deployment-owned overlay can attach the ordinary relay
to an explicitly created private network shared with the application backend:

```yaml
services:
  relay:
    environment:
      EZ_APPLICATION_PORT: "8787"
      EZ_APPLICATION_HOST: "0.0.0.0"
    networks:
      default: {}
      application:
        aliases: [standard-agent]
networks:
  application:
    external: true
    name: ${EZ_APPLICATION_NETWORK:?Set the deployment-owned application network}
```

Create that network once through normal Docker administration; attach the backend
to the same external network in its own deployment overlay. Preserve the default
network. The backend connects to `http://standard-agent:8787`; no `ports` entry or
host listener is required. Keep the overlay outside the package, owned by the
deployment, and include it in that deployment's saved Compose invocation. This is
an explicit network configuration, not a second runtime or automatic discovery
service. Read back the loaded package/image and verify a real authenticated app
request after switching; preparation and image build alone are not rollout.

## Shared backend client and private principals

Node backends can import `applicationBinding`, `applicationCall`, and
`runApplication` from `@jc_stack/ez-agents/application-client`. This is a small
HTTP client; core remains the sole owner of agent execution. Pin the package
revision in the application's lockfile. Do not copy this client into each app.

`applicationBinding(file, principalId)` reads a backend-private registry:

```json
{"version":1,"bindings":[
  {"principalId":"verified-person-one","url":"http://person-one-agent:8787","tokenFile":"/run/secrets/person-one"},
  {"principalId":"verified-person-two","url":"http://person-two-agent:8787","tokenFile":"/run/secrets/person-two"}
]}
```

Resolve identity in the app before lookup. Unknown and revoked principals fail
closed. Set `revoked:true` to remove a mapping from new lookup and revoke its
core application grant to stop admitted work. Do not use a default owner's
connection. Each endpoint must be a separate ordinary Ez deployment with private
workspace, native CLI state, OS/container access and tools. The client rejects
reused endpoint origins, but cannot prove that two DNS aliases name different
containers. Provision isolation explicitly; this registry does not create it.
The backend's registry and service credentials must not be mounted in an agent.

The app keeps its existing user and coach/tutor grants. A delegated principal
must be distinct from the learner's personal principal, and every domain tool
must recheck the current grant. A coach can edit permitted learner records
without inheriting the learner's private agent conversation. No new role system
is required in Ez.

Use `runApplication({requestId,scope,text,context}, connection)`. It returns the
completed snapshot plus `reply`, the last nonempty message. An interrupted or
invalid HTTP response reports a retryable transport error; the caller reconnects
using the same persisted job ID and authority. The client does not resubmit by
itself. `applicationCall('/v1/runs/<id>/cancel', {}, connection)` uses normal
core cancellation. Aborting a local poll does not cancel admitted work.

Snapshots also expose `sessionId`, `nativeSessionId` when known, and `cli`.
An optional `expectedNativeSessionId` on submission is an assertion, never a
session selector. It rejects a missing or different imported history before
execution. Import old histories administratively before cutover. An optional
`ai:{cli,model,effort}` uses the existing preset/effort contract; a scope keeps its
CLI, while model/effort can change for later turns. Use distinct scopes for
separate CLI histories. A retry cannot change an admitted turn's AI choice.

## One owner across channels

Register owner-chat channels with `--share-owner` and submit `followOwner:true`.
Web, phone and Telegram then use the same selected native conversation and AI.
A later same-client provider or model change starts a new native conversation for the next
admitted turn; already-queued work keeps its original engine.
This works without Telegram and requires no transcript replay or new runner.
Scoped application conversations remain separate when the flag is omitted.
Owner identity does not automatically merge histories or grant learner access.

To link Telegram, enable its ordinary bot configuration, then use the
application-initiated handoff below or send a real DM and approve the observed
pending identity using `ezenciel-agents-owner approve ID`.
`ezenciel-agents-owner unlink-telegram` removes that channel without removing the
owner, application bindings or native sessions. Relinking does not authorize old
Telegram deliveries. Linking other providers requires an authenticated adapter;
registering the label `phone` does not install a phone service.

### Application-initiated Telegram handoff

An already-authorized `--share-owner` application binding can make the ordinary
Telegram link easy without becoming a Telegram backend. `GET /v1/telegram`
returns the current `connected` state. `POST /v1/telegram/link` either returns
`{connected:true}` or a single-use, short-lived `https://t.me/BOT?start=TOKEN`
link. The bot accepts that token only from the matching application's current
owner, then persists the normal Telegram owner/channel record and consumes the
ticket. The raw token is never stored in control state.

This is a launch handoff, not a UI-owned connection: the application does not
store Telegram identity, bot credentials, or the ticket, and the Ez agent keeps
working when that application is unavailable. There is deliberately no
application disconnect endpoint. Administrative unlink remains the explicit
owner control above.

The legacy `--share-telegram`, `--share-active` and `followTelegram:true` spellings remain supported.

### Existing scoped Telegram sharing

For an application using the ordinary agent's Telegram channel, the administrator
may register its grant with `--share-telegram`. An ordinary application turn can
then send `activateTelegram:true`: its scoped session becomes the owner's current
Telegram conversation. Both inputs resume the same native history. Shared scopes
appear in the existing `/chats` selector. Omit activation for temporary selection,
extraction, and delegated work; those must not switch the personal conversation.
Without the administrator's flag, application requests cannot switch Telegram.

For a main chat that should follow the owner's current Telegram conversation,
submit `followTelegram:true` under the same administrator-approved sharing grant.
This uses the normal selected conversation and AI at admission, including after
`/new`, `/chats`, or `/ai`. Do not also send `activateTelegram`, `ai`, or a native
session assertion. Retries remain pinned to their originally admitted run even
if the owner has since switched conversations. Keep exercise/detail scopes on
the ordinary scoped path by omitting this flag.

This shares native context, not an application's transcript database. Existing
Telegram-to-backend integrations are a legacy limitation. Drain/reconcile their
actual admitted runs before moving Telegram onto ordinary Ez transport and app
admission onto this path. Do not introduce an application execution queue or
route a channel-backend job into its own occupied execution queue.

For backends holding a data lock across a native turn, `reconnect:true` keeps
retrying transient transport failures with the same admitted request/GET until
core reports the outcome. It never changes a job or capability. Do not apply a
wall-clock abort that releases the data lock while remote execution continues.
Persist a restart barrier before admission if backend restart could otherwise
allow conflicting domain writes. Core remains the execution owner.

A rejected submission includes `admitted:false` only when core can verify that
no run exists for that binding/request ID. An existing conflicting run produces
`admitted:true` and `runId`. Authentication or unreadable state may leave admission
unknown. Backends may release a pending data barrier on explicit non-admission;
a generic HTTP error or revoked credential alone is not proof of termination.

## Application-only deployment (no Telegram bot)

For a private per-user native runtime, omit `TELEGRAM_BOT_TOKEN` and set
`EZ_APPLICATION_PORT` (plus `EZ_APPLICATION_HOST` when other containers connect).
This mode runs the existing native executor,
application queue and application outbox without creating a Telegram client,
starting Telegram sources/polling, or registering bot commands. Telegram becomes
active as soon as the agent receives its private bot token.

Upgrade note: the removed `EZ_TELEGRAM_ENABLED` flag is no longer read. A stale
flag that contradicts the token (disabled flag with a token present, or enabled
flag with no token) refuses to start — unset the flag, and remove any stale
`TELEGRAM_BOT_TOKEN` to stay application-only.

The installing administrator can initialize empty control authority and register
an application in one local command:

```sh
ezenciel-agents-application --id web --token-file /run/private/application-token --owner-id VERIFIED_ACCOUNT_ID --share-owner
```

No Telegram ID is required or fabricated. Account identity remains server-resolved
by the app and bound to its isolated runtime. Registration is unavailable inside
agent turns and cannot replace an existing owner or adopt orphaned session state.
Existing owners require no bootstrap. Tokens remain private; normal binding and
run authorization checks still apply. The old numeric `--owner` option is retained
only for compatibility, not recommended for new installations.

Each learner/coach principal requires its own workspace, CLI state and isolated
runtime. No separate bot is required. A channel is an authenticated route to its
existing owner, not a new owner, scheduler or native execution engine.

The standard scheduler, task controls and native delegation remain available.
Schedules created during an application turn retain its binding and reply scope;
scheduled replies use the normal outbox and appear in `GET /v1/runs` (100 channel
runs per page), with their `originRunId`. Follow `nextCursor` through
`GET /v1/runs?before=RUN_ID` until null to catch up after a disconnect; receipts
from older origins must not be limited to the UI's current page. The backend projects these receipts into
its UI; it does not schedule or execute work. Revoked channels cannot launch or
receive scheduled work. Token rotation retains delivery. Telegram-specific intake
and delivery require Telegram; pending Telegram work is never rerouted to web.

When a private container supplies the isolation boundary and
Codex cannot create its nested sandbox, its installing administrator may set
`EZ_CODEX_SANDBOX=external` together with `EZ_EXECUTOR_TRANSPORT=local`.
Local owner-authorized Codex app and Telegram turns use
`--sandbox danger-full-access`. Native scheduled owner sessions use Codex's
`externalSandbox` turn policy, with network access supplied by the container.
The default remains `workspace-write`.
Keep the container's private mounts, non-root UID, dropped capabilities and
no-new-privileges policy; the agent can access everything mounted into it.
Use standard root-start relay privilege separation when Telegram/provider
secrets are present; do not put those secrets in a same-UID process environment
or readable mount. This setting is rejected for host/backend execution and
restricted delegated tasks, and cannot be selected by an application request.
It is not forwarded to the host executor.

## Generic inbound attachments

`POST /v1/runs` (and `runApplication`) accepts one optional
`attachment: {name, data}`, where `data` is canonical padded base64 of the file
bytes. `text` remains the literal user comment and may be empty with an attachment.
JPEG, PNG, WebP, PDF and UTF-8 TXT/Markdown (`.txt`, `.md`, `.markdown`) are supported,
up to 10 MiB decoded; empty files and other types are rejected. Core detects file
content rather than trusting a client MIME label. This same limit and staging
contract apply to Telegram photo/document input.

Authentication precedes staging. Core stages the file privately under the
deployment control directory and uses the same attachment metadata and literal
comment as Telegram. The existing run queue, native executor, selected AI and native session
remain authoritative; applications must not extract, summarize, convert or build
attachment prompts. Use `followOwner:true` for the shared owner conversation.
Retry the same request ID, filename, bytes and literal comment; conflicts return
409 and successful retries do not stage another file. A failed admission removes
its staged file; a process crash may leave an unused staged file, never a runnable
partial request. Separate owner runtimes must retain separate workspace mounts.

This is inbound file support. Application replies currently deliver text only;
outgoing file downloads remain unsupported by this HTTP channel.
