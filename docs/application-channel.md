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

## Optional direct Telegram continuity

For an application using the ordinary agent's Telegram channel, the administrator
may register its grant with `--share-telegram`. An ordinary application turn can
then send `activateTelegram:true`: its scoped session becomes the owner's current
Telegram conversation. Both inputs resume the same native history. Shared scopes
appear in the existing `/chats` selector. Omit activation for temporary selection,
extraction, and delegated work; those must not switch the personal conversation.
Without the administrator's flag, application requests cannot switch Telegram.

This shares native context, not an application's transcript database. Apps using
the older Telegram-to-backend channel should continue routing both channels into
their canonical app job first, using the same principal and scope. Do not route a
channel-backend job back into its own occupied execution queue.

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
