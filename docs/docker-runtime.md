# Docker runtime and shared host CLI

Docker Compose owns each relay and executable plugin. Isolated agents run the
native CLI from the relay image (pinned Codex). Host-capable agents reuse the
CLI the user installed Ez from, with its existing authentication. The relay
image contains Node, relay dependencies, ffmpeg and that pinned Codex CLI.
The runtime image exposes Ez commands through the wrappers in `/app/bin`, including
`ezenciel-agents-application`; application images do not need to link Ez themselves.
The image also installs package-manifest commands in `/usr/local/bin`, so native
engine login shells can resolve them after resetting PATH. Command installation
belongs to Ez packaging, not an application image or an engine-specific prompt.

## Agent binding

Use [agent-led setup](setup.md). `ezenciel-agents-create` accepts a name, purpose,
optional `--isolation isolated|host-capable` (default `isolated`),
a bot token through stdin; the CLI defaults to the one recorded at package
installation by `--register-cli <current-cli>`. It creates a private deployment
with a unique Compose project, mind, control directory and secret file. Names
cannot overwrite existing agents. `installation.json` keeps subsequent agents
on the same CLI. Each agent gets its own purpose and native conversation IDs.
`isolated` sets `EZ_EXECUTOR_TRANSPORT=local` and runs the native CLI in the
relay. `host-capable` sets `host` and reuses the installer UID; unlabeled
existing host transports stay host-capable so they are not flipped.

On Docker Desktop/OrbStack the control volume's Unix socket is not connectable
from the macOS host, so a host-capable agent also publishes an authenticated
loopback ledger endpoint (generated `ledger.compose.yaml` plus
`EZ_DELIVERY_TCP_PORT` in `docker.env`). The relay writes
`control/delivery-endpoint.json` (mode 600) with the port and per-start token;
host CLIs fall back to it when the socket is unreachable, and every request is
still re-authorized server-side. Isolated agents publish no endpoint. If the
chosen port is taken, recreate the agent or edit `EZ_DELIVERY_TCP_PORT` and
re-run Compose.

`docker.env` contains explicit absolute paths, never token values:

```dotenv
COMPOSE_PROJECT_NAME=ez-agent-family
EZ_EXECUTOR_CLI=grok
EZ_ISOLATION=isolated
EZ_EXECUTOR_TRANSPORT=local
EZ_AGENT_WORKSPACE=/absolute/private/agents/family/mind
EZ_CONTROL_DIR=/absolute/private/agents/family/control
EZ_RELAY_ENV_FILE=/absolute/private/agents/family/relay.env
EZ_AGENT_PURPOSE_FILE=/absolute/private/agents/family/purpose.md
EZ_TOOLS_HOME=/absolute/private/agents/family/tools
EZ_PLUGIN_BROKER_SOCKET=/absolute/private/agents/family/control/plugin-broker.sock
EZ_PLUGIN_BROKER_HOST_CONFIG=/absolute/private/agents/family/host-executor.json
```

Host-capable agents run `ezenciel-agents-host` under the host's service manager
with `EZ_DEPLOYMENT_DIR` bound to that deployment. This small transport invokes
the existing CLI; it is not a second relay or model loop. Isolated agents do not
start it. It reads requests from
the agent's control directory, fixes cwd/control/tool paths from its installation
binding, strips environment secrets, forwards native output and exit status, and
propagates cancellation. Requests cannot select another executable. No network
listener, Docker socket in containers, new provider API or per-CLI service shim
is required. Host Node 22+ and the package dependencies run this transport.

Mount mind and control at identical absolute paths in Docker and on the host,
so incoming files, message attachments and CLI outputs need no path translation.
Only that agent's directories are mounted into its relay. Host-capable CLI reuses the existing login. Codex receives a private per-agent
state home with linked authentication; global memory/configuration is excluded.
Host-capable is not an OS security boundary between agents running as the same user.
Isolated agents use the relay mounts; sibling host paths are not present.
Plugin setup also binds `toolsHome` in the host configuration. The isolated
runtime uses a separate `plugin-broker` Compose service: the relay receives only
the socket client and its normal mind/control mounts, while the broker receives
that agent's exact tools/workspace/control paths and the Docker socket. The
broker has no network, validates the host binding and registry owner, and is the
only service allowed to launch plugin containers. The relay never receives the
Docker socket or a tools registry mount. Host-capable agents keep the existing
host executor path instead.

## Operate and verify

Root-started containers default to executor UID/GID `1000:1000` and relay real
UID `1001`. To preserve an existing private workspace's ownership, set
`EZ_RUNTIME_UID`, `EZ_RUNTIME_GID` and, if necessary, `EZ_RELAY_UID` in the
deployment environment. IDs must be positive decimal integers; the relay real
UID must differ from the executor UID. The entrypoint retains its secret file
descriptor and privilege separation, then runs the executor with the configured
UID. It changes ownership only on the top-level control, home and workspace
directories; it does not recursively change existing data. Provision nested
files/mounts for that UID before starting. These settings apply to root startup;
an explicit Docker `user` still controls an already non-root process.

Changing IDs is an operator installation step, not a new tenant-isolation
mechanism. Keep private mounts and secrets isolated as described above. This
option does not change native sandbox or channel support.

```sh
export EZ_DEPLOYMENT_DIR=/absolute/private/agents/family
bin/ezenciel-agents-docker up -d --wait
bin/ezenciel-agents-docker run --rm relay owner status
bin/ezenciel-agents-docker run --rm relay owner approve <verified-numeric-id>
bin/ezenciel-agents-docker stop relay
bin/ezenciel-agents-docker run --rm relay smoke
bin/ezenciel-agents-docker up -d --wait
```

The owner supplies a real DM; verify the pending numeric sender before pairing.
Live smoke uses the same host CLI and requires an actual Telegram receipt.
Restart preserves pairing and files. On boot the relay binds the live delivery
socket as the single-relay guard: a second relay refuses to start while that
address answers. Do not remove a live socket to bypass the guard.
Health requires recent polling and host-transport heartbeats, not just a process.
Relay replacement retains the existing 30-second startup grace and deployment
layout, so compatible releases remain eligible for agent-owned upgrades.
An interrupted Telegram poller keeps authorized work and in-flight deliveries
alive while it retries intake. Run and delivery records are relay memory: a
relay process restart drops in-flight work by design, Telegram redelivery is the
intake replay path, and uncertain sends report unknown instead of success.
A `409 Conflict` still requires the operator to stop the competing poller; it
remains unhealthy after the startup grace. Pending and uncertain deliveries keep
their existing receipt semantics; executor stdout is not replayed as a reply.
Signal and fatal-error paths share one shutdown; a secondary cleanup error is
reported without replacing the original startup/polling failure.

For an isolated agent, `COMPOSE_PROFILES=isolated` starts both `relay` and
`plugin-broker`; the `up` command above must not be narrowed to `relay`. The
broker socket is private to the agent's control directory. Its per-run receipt
is written under `control/plugin-receipts/<run-id>/`; a plugin's stdout remains
the provider/API receipt and is not treated as a relay message.

The separate `control-state.lock` serializes authority JSON updates across CLI
processes. A forced kill or host crash can orphan this exclusive-create sentinel.
It deliberately has no age/PID-based auto-reclamation: expiry cannot prove that a
paused writer is dead, and host/container PIDs are not interchangeable. For an
orphan, stop the relay and all CLI writers for this deployment, preserve its
control state, then remove only the verified orphaned `control-state.lock` and
restart the single relay. Never remove a lock while a writer might still be live.
Model catalog metadata is exported from the selected host CLI without credentials.
The AI menu stays within that CLI. No automatic executor fallback is performed.

## Secrets and plugins

The relay secret file is private and outside the mind. A short root bootstrap
opens it, protects `/run/secrets`, and drops capabilities. The relay runs with
distinct real/effective UIDs to deny process-memory reads; local container tool
processes normalize to UID 1000. Relay secrets never enter configured container
environment or host CLI environment. Container isolation tests cover these
boundaries; the trusted host account can still administer installation files.

Each plugin owns its Docker image, dependencies, private profile, onboarding
and receipts. The agent-bound `ez` registry is the only plugin authority:
`ez plugins list`, `ez plugins install`, `ez plugins start|stop|status`, and
`ez <alias> ...`. Its reviewed deployment descriptor supplies literal command
and volume bindings. Never add standalone provider launchers or deployments.
Read the installed skill from the registry before onboarding; do not re-pair
an already connected account. Monitoring and sends require their own authority.

### Isolated plugin commands

The relay-side `ez` client sends only declared aliases, literal argument arrays,
bounded stdin, and the active run ID to the broker. The broker re-reads owner
authority and the registry before every call, pins the discovered revision, and
passes only the installed plugin's `run.application.context.plugins[plugin-id]`
object as `EZ_PLUGIN_CONTEXT`. Missing, revoked, cross-agent, expired, or reused
admissions fail closed. Timeouts, cancellation and bounded output produce a
failed broker receipt rather than a retry.

Source-based `plugins inspect`, `catalog-add`, and `install` management calls are
accepted only for an existing path inside that agent's mounted workspace, with a
literal SHA-256 revision where the command requires one. The same management
surface permits data-preserving `plugins uninstall` and local candidate
`updates prepare/apply/recover`; candidate archives must also be inside the
workspace. Public update discovery stays with the host supervisor because the
broker has no network. The broker never turns an arbitrary host path into a
plugin mount.

Each agent has one registry and one broker binding. Registries, plugin source
snapshots, shared workers and Library/embedding state are not implicitly shared
between agents or organizations. A reviewed shared worker or an application
backend must be attached through its own explicit per-agent binding; it does not
grant the relay or Library containers Docker access.

An isolated agent created before this change has no `tools/` directory, broker
socket environment, or `COMPOSE_PROFILES` entry: recreate the agent (or backfill
`tools/`, `EZ_TOOLS_HOME`, `EZ_PLUGIN_BROKER_SOCKET`,
`EZ_PLUGIN_BROKER_HOST_CONFIG`, and the isolated profile) before its plugins
will run. Until then the broker refuses to start and health reports
`PLUGIN_BROKER_UNREADABLE` — fail-closed, never half-provisioned.

For event intake, mount only the registered plugin project's socket/client
exports into the relay, read-only. The event source stores a cursor and policy
binding; it is not a second plugin installation. Provider credentials remain in
the plugin profile. Keep this event mount aligned with the registry-owned project.

## Migration and rollback

Stop and disable the exact old poller/profile service. Back up mind, control,
plugin profile and relevant native sessions first. Copy canonical relay state to
its per-agent bind directories and plugin state into its own volume. Preserve
pending/uncertain operations without replay. Never run two copies of a bot token
or linked profile. Keep the same selected host CLI and its existing login.

To roll back, stop Docker and the host transport first, deliberately reconcile
newer state, then restore the recorded old service. Never use `down -v` on a live
profile. Docker smoke uses fixtures; it is not proof of provider delivery, phone
UI, voice or buttons. Run the explicit real smoke separately while the poller is
stopped. A previously containerized native session needs deliberate history/path
migration before `--resume`; do not silently reset it.

The installing CLI is an initial default, not a permanent restriction. An explicit
owner selection may use any supported CLI/model installed on the host. Native
`ezenciel-agents-ai list` and `select` expose this choice. A cross-CLI switch
starts a fresh native conversation and preserves the mind and installation
default. Existing queued jobs retain their captured execution choice.

## Codex context isolation

Isolated agents run the image Codex with `EZ_CODEX_SANDBOX=external`. Auth is a
real file at that agent's `control/cli/codex/auth.json`. Do not bind-mount the
operator `~/.codex` or `$HOME` into an isolated relay. Host-capable agents reuse
the host Codex binary and login, with a
`control/cli/codex` state directory. The native CLI is resolved from the host
PATH, not the package `binDir`, so a shared runtime or one agent's wrapper cannot
retarget another agent's `CODEX_HOME`. Only authentication is linked to the host
login; global configuration, sessions and memories are not imported. Global
memory and host skill discovery are disabled for relay jobs. A conversation
that already received unrelated global context must be replaced with a fresh
native conversation; disabling injection does not remove prior turn content.
This prevents automatic context sharing, not adversarial access by the host user.
On macOS host jobs, Seatbelt also denies sibling directories of the bound
workspace (a tenant farm), while allowing explicitly shared and additional
workspace grants and leaving `$HOME` readable for the host CLI.
Codex then uses `danger-full-access` so it does not apply a nested Seatbelt.

## Chat latency

Interactive Codex CLI turns resume the existing native session and use native
auto-compaction at 64,000 tokens. Set `EZ_CODEX_AUTO_COMPACT_TOKENS` in the Compose
environment to change the positive integer threshold (for example, 32000 for
lightweight chat). The setting crosses the host transport as a numeric option;
relay secrets are still excluded from CLI environments. Older oversized sessions
can take an extra compaction turn. Ez does not reconstruct transcripts or own a
separate memory/compaction engine. Other providers, Codex desktop, native scheduled
sessions and delegated tasks retain their own context policies. Channel backends
such as AIFit own inference and must configure their own context limits.

Content-free `run timing` logs identify the run and phase: queue wait and launch
startup, executor duration (including model and tool work), and successful outbox
delivery processing plus time since run creation. Host transport startup includes
its polling delay in executor duration; it is not a pure model-inference measure.
Delivery processing includes pacing, media preparation and provider calls. A sent
message may precede executor exit. No prompt, message body or credentials are added
to these timing logs.

### Polling faults

Permanent errors escaping Telegram setup/polling (including unauthorized tokens,
competing pollers and programming errors) stop relay-level retry until explicit
restart after repair. Existing authorized work and outbox draining remain active;
polling health remains unhealthy. Transient HTTP, rate-limit and server errors
may reconnect. grammY still owns reconnect behavior inside its poller; ez does
not override private library methods or implement a replacement poller.
