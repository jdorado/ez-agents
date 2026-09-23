# Changelog

## 0.1.0-beta.37

- List installed OpenCode models with their provider variants as selectable
  efforts in Choose AI, chat and scheduled tasks. The relay spawns the
  installed `opencode` CLI with the whitelisted executor environment, so the
  menu reflects that CLI's reported catalog; variants pass through verbatim as
  `run --variant` on every platform. Restricted messaging tasks stay on the
  audited Codex. The relay image now ships pinned OpenCode 1.18.32 for
  isolated agents; host-capable agents reuse the host installation.
- Provision authenticated OpenCode providers per agent through
  `control/cli/opencode/auth.json`: isolated runs resolve it via an
  agent-bound data home. Paid models may appear in the catalog; execution
  depends on valid provider authorization. Host runs keep the installer login
  and the free tier stays the fallback.
- Scope selectable OpenCode catalog entries with `EZ_OPENCODE_PROVIDERS` (e.g.
  Go only): unlisted providers, including the free tier, leave the menu.
  Isolated relays read it from their environment; host transports take
  `opencodeProviders` on the agent's host binding instead. An existing
  model-less default still follows the native client's provider choice.
  Existing deployments need an installer-owned bootstrap for the new Compose
  environment field before their automatic main updater accepts this release.
- Allow unbound plugins to run through the isolated broker when a different
  installed plugin declares a host network binding; bound plugins still fail
  closed on an isolated deployment.
- Add a Pi native executor with the exact conversation session ID. It offers
  its native default when no provider scope is set. Owner-curated model choices
  require Pi's own provider credentials and are filtered by scope. The relay
  image installs pinned Pi 0.87.1.

## 0.1.0-beta.36

- Move relay run/outbox/inbox bookkeeping into relay memory behind the control
  delivery socket. A restart drops in-flight runs and queued deliveries by
  design; Telegram redelivery is the replay mechanism. The live socket replaces
  the relay flock as the single-relay guard.
- Slim the spawn core to spawn and stream only. Callers authorize admission and
  pass the one trigger suffix; the core no longer reads the run ledger, history
  or workspace.
- Add a dedicated plugin-broker service (isolated profile) that owns Docker
  access with no network access. Isolated plugin commands run over a Unix socket
  with single-use capabilities, pinned revisions and per-invocation receipts.
- Publish installed plugin versions through the broker and report the deployed
  build identity; show the running RC tag, isolation/transport mode and host
  platform in `/status`.
- Add `ezenciel-agents-provision-telegram` to attach a Telegram channel to an
  existing botless deployment using that deployment's installed image.
- Add the Telegram `/tasks` list with numbered detail, attach Telegram identity
  to an existing web owner, and infer Telegram transport from the token instead
  of `EZ_TELEGRAM_ENABLED`.
- Remove PagerDuty and Workforce Watch from core. Authorization, transport,
  scheduling, safety gates and delivery receipts remain.
- Stop waking the agent for software updates. The supervisor no longer writes an
  attention notice and the relay no longer queues a wrapper-owned
  `software_update_attention` run, so nothing outside the managed `ez tools`
  locator is injected into an operating agent. `ez updates` stays owner-invoked.
- Stop injecting a package-owned coding handbook into operating-agent
  `AGENTS.md`. Upgrades strip the old `ez shared guidance` block. Seed only the
  installer purpose. The managed `ez tools` locator binds the agent launcher
  (`ez --help` and `ez tools list --details`); inventory is generated on read.
  Do not create `inbox/`, `work/`, `SOUL.md`, or `USER.md`.
- Generalize compatibility bridge upgrades so `.compat.N` builds hand off to
  their canonical release, and allow reviewed legacy homes without `docker.env`.
- List the agent-bound Codex catalog in `/ai` for local relays, make declared
  provider models authoritative and migrate persisted provider selections.
- Source-checkout RC builds require a clean reviewed commit and an increasing
  `.rc.N` label; the label and commit SHA are baked into the image and shown
  first in `/status`.
- Existing host-capable deployments need one installer-owned migration before
  this release: `ezenciel-agents-install migrate-ledger --deployment <dir>` adds
  the authenticated loopback ledger endpoint. Pre-beta.36 deployments also need
  the installer-owned bootstrap because the new `plugin-broker` service and
  environment changes do not match the previous release's deployment gate.
- Fix plugin application context delivery into the command container, plugin
  status JSON parsing under Compose warnings, and EPERM lease liveness.

## 0.1.0-beta.35

- Harden the beta.34 compatibility upgrade path, including supervisor handoff
  after a completed main upgrade and cleanup of obsolete terminal backups while
  retaining active, queued and rollback state.

- Publish one plugin author standard for local-only installation, exact public
  releases, catalog registration, package boundaries, and executor verification.

## 0.1.0-beta.34

- Correct setup guidance for host-capable custom Codex providers and replace
  stale pinned-beta installation guidance with current release records.

- Retain only the newest completed updater backup per target and reconcile older
  terminal backups after updates and supervisor restarts, without touching
  active, queued or rollback state.

- Let existing agents self-upgrade across the beta.34 runtime compatibility
  migration while retaining fail-closed rejection of structural deployment
  changes.

- Record the reviewed Library beta14 command-contract migration and hand a
  completed main upgrade back to the retained bootstrap so the new updater code
  is loaded without a manual supervisor restart.

- Record an isolation class at agent creation. The default is `isolated`: the
  native CLI runs in the relay (`EZ_EXECUTOR_TRANSPORT=local`). Pass
  `--isolation host-capable` to reuse the installer UID and host CLI login.
  Mismatched class and transport fail closed. Isolated Codex sets
  `EZ_CODEX_SANDBOX=external`. Host transport is not started for isolated
  agents. Unlabeled existing host transports stay host-capable.
- Install pinned Codex CLI `0.153.4` in the relay runtime image so isolated
  agents resolve `codex` on PATH. Isolated jobs keep auth in
  `control/cli/codex` and do not link the operator `~/.codex`.

- Confine macOS host jobs to their bound workspace and prevent cross-agent
  plugin registry access.
- Support agent-scoped OpenRouter models through the native Codex engine and
  start a new native session when the provider or model changes.
- Resolve native CLIs from the host PATH, expose captured presets in application
  run receipts, and seed one purpose-scoped AGENTS.md for new agents.

## 0.1.0-beta.33

- Allow compatible plugin updates to add commands to existing services, registering
  their aliases atomically while retaining collision checks and rejecting changes
  to existing command routes or deployment authority.
- Simplify contribution guidance and bound independent constraint reviews without
  changing the native engine, transport or plugin responsibility boundaries.

## 0.1.0-beta.32

- Add shared authenticated inbound attachment staging for application and
  Telegram channels, preserving literal comments and immutable retries.
- Support separately scoped host-owned writable workspaces.
- Reconcile reused host-lock PIDs using process birth identity while failing
  closed on unknown or matching live-process identity.
- Accept bounded scheduler recovery identifiers and preserve reviewed package
  modes when extracting under a restrictive umask.
- Allow concurrent plugin commands, scoped approved outgoing files, and the
  host CLI configuration needed for restricted read-only plugin commands.
- Clarify domain-agent positioning while preserving native engine ownership.

- Prevent accidental cross-agent plugin access by rejecting relay-bound registry
  calls outside the owning workspace, and restrict its host-folder bindings to
  workspace roots explicitly granted by the host.
- Answer native app-server requests with their current protocol shapes. Scheduled
  `codex-gui` browser work now surfaces approval requests and grants only its
  active turn session-scoped HTTPS browser-origin and Chrome app elicitations,
  while audio, cross-turn, unrelated elicitations and approvals remain declined.
- Restore `codex-gui` tasks when newer Codex Desktop builds do not create the
  legacy control socket at app launch: invoke the native idempotent app-server
  daemon start command and retry the desktop connection once, while retaining
  fail-closed behavior and never falling back to headless execution.
- Add owner-approved, provider-neutral public channel grants so restricted fresh
  agent runs can answer any private chat or mentioned group on one enabled source.
  Grants may expose only fixed, read-only query aliases such as Library search;
  they retain no owner memory, recheck revocation around every operation, and
  enforce persisted concurrency, traffic, receipt and evidence bounds.

## 0.1.0-beta.31

- Make the owner-authorized contribution lifecycle explicit in shipped agent
  guidance: take a coherent change through independent final-head review, CI,
  applicable QA and, when authorized, merge. Release authority includes the
  merge needed for publication, which continues through the reviewed GitHub
  publisher, registry readback and eligible runtime verification. Preserve local
  QA, diagnostics, auth-only work and deployment as separate boundaries.

## 0.1.0-beta.30

- Bind installed native command launchers to the deployment's canonical control
  directory. This makes application registration use the owning agent's state
  and prevents caller environment variables from redirecting that authority.

## 0.1.0-beta.29

- Republish the beta.28 Voice connection and web-serving contract at a monotonic
  version so installations already running private beta.28 QA builds can upgrade
  through the standard verified public-package path. Runtime behavior is unchanged.

## 0.1.0-beta.28

- Hide empty conversation placeholders from history and update the same menu
  when navigating Back, rather than adding another menu message.
- Keep the conversation list to names only; show Archive/Restore for the selected
  conversation. Label older chats from saved owner messages instead of opaque IDs.
- Add named Telegram conversations with switching, renaming, archiving and
  restoring. Preserve native engine bindings and queued work across switches.
- Add the authenticated application channel to the standard runtime, including
  botless deployments, explicit owner sharing, native conversation continuity,
  isolated non-root containers and writable-folder grants.
- Add owner-bound persistent plugin connections with installed-tool discovery,
  native task access and revocation-safe Telegram delivery receipts.
- Add explicit loopback-only `tools serve`, live read-only owner discovery and an
  optional authenticated private-chat Mini App launcher for plugin-owned web UIs.
- Fix packaged application command availability and private-plugin update checks.
- Document agent-owned maintenance for separately deployed applications and add
  owner-bound, on-demand Telegram delivery-history lookup across native sessions.
- Clarify the native-engine, transport and plugin ownership boundaries and the
  proportionate KISS contribution/review standard.

## 0.1.0-beta.27

- Pass literal task input and `/goal` requests to the selected engine; remove
  workflow prompt assembly and transport-owned goal creation.
- Slim shared instructions and discover installed plugin guidance on demand.
- Let engines own concurrent execution instead of reserving shared workspaces
  for entire runs. Preserve authorization, request ownership and cancellation.
- Clarify chat delivery and acknowledgement through the bound message CLI,
  and decode inline newline escapes in messages.
- Show active scheduled-task details and simplify AI selection in Telegram.
- Stop self-feeding maintenance and keep optional transport failures isolated.

## 0.1.0-beta.26

- Start local software-maintenance wakeups in independent ephemeral sessions,
  including after a relay restart, without trying to resume or persist a
  normal owner conversation. This prevents successful upgrades from producing
  false "failed to start" notifications across direct relays.

## 0.1.0-beta.25

- Enable Codex Luna `max` reasoning for durable work, schedules and deferred
  owner handoffs. New durable work defaults to Luna/max while responsive chat
  remains Sol/medium.
- Preserve the strict cap for every other model and expose Luna/max from the
  installed model catalog.
- Persist Luna/max defaults in rollback-readable form; launch-time policy still
  resolves Luna without an explicit effort to `max`.

## 0.1.0-beta.24

- Preserve host-owned private plugin networks across generated Compose services,
  one-shot commands and compatible updates. Bind routes to reviewed plugin
  revisions and retain plugin-local connectivity.
- Support existing deployments on their first upgrade. Network authorization
  remains outside the agent-writable registry. Existing beta acceptance limits remain.

## 0.1.0-beta.23

- Identify failed publisher API reads and missing release tags without exposing
  credentials or signed asset URLs. Document verified tag/artifact staging and
  recovery before a fresh publication attempt.
- Include beta.22 incomplete-update-receipt recovery; the earlier unpublished
  candidate remains preserved. Existing beta acceptance limits remain.

## 0.1.0-beta.22

- Ignore incomplete or malformed update-receipt directories until a valid,
  atomically committed `job.json` exists. They have no activation authority and
  must not take the host executor offline.

## 0.1.0-beta.21

- Initialize fresh Telegram bots before reading their identity. Beta.19 could
  retry forever before polling, causing main upgrades to fail their health gate.
- Restore the unchanged deployment layout required for upgrades from beta.18
  and beta.19; extending health grace does not fix the initialization failure.
- Include beta.20 health diagnostics. Preserve the earlier immutable unpublished
  candidate; existing beta acceptance limits remain.

## 0.1.0-beta.20

- Retain a bounded, content-free health predicate in a failed main-upgrade
  receipt before rollback replaces the candidate relay. This distinguishes relay
  polling and host-executor heartbeat failures without persisting control-state,
  provider, environment, or Docker diagnostic content.

## 0.1.0-beta.19

- Preserve host-backed run completion and delivery evidence while the relay
  finalizes state, rather than treating the host PID as a relay-local worker
  process. Interrupted host transport and deliberate schedule cancellation retain
  their distinct terminal states.
- Include the reviewed scheduled-task status, Workforce Watch, plugin-folder,
  scheduler-model, incident-reopening, and catalog updates merged after beta.18.

## 0.1.0-beta.18.1

- Add explicit read-only existing-folder bindings for plugin services, preserving bindings across compatible updates without copying source files.


## 0.1.0-beta.18

- Await complete relay cleanup after fatal Telegram polling errors and preserve the primary failure.
- Refresh package-owned shared guidance in owner worker prompts, including resumed and scheduled work, while preserving personal workspace instructions and restricted worker boundaries.
- Include the reviewed beta.17 fixes. Earlier immutable unpublished candidates and existing beta acceptance limits remain.

## 0.1.0-beta.17

- Capture executor stderr before asynchronous PID persistence so fast failures retain actionable, redacted diagnostic evidence for agent-owned recovery.
- Wait for executor cleanup and final run-state writes when stopping the relay, so shutdown does not return while its state is still being written.
- Include the reviewed beta.16 runtime and catalog corrections. Earlier unpublished candidates remain preserved; existing beta acceptance limits remain.

## 0.1.0-beta.16

- Correct stale plugin-publication claims and link the catalog to live npm/GitHub release records. Agents must verify available versions instead of treating a dated catalog snapshot as a blocker.
- Include the reviewed beta.15 runtime unchanged. Preserve earlier unpublished candidates and existing beta acceptance limits.

## 0.1.0-beta.15

- Include current reviewed model defaults, reply/status fixes, shared Library services and CPU limits, and the corrected main-CI publisher validation.
- Testing beta; previously documented live-provider and fresh-host acceptance limits remain.

## 0.1.0-beta.14

- Preserve agent-specific scheduled authentication and model catalogs; show native
  Codex defaults in status, and support explicitly approved group ownership.
- Keep owner chat responsive during shared work with restricted reply sessions.
  Capture redacted failure evidence and support quiet, owner-scoped reviews.
- Add opt-in shared Docker plugin workers and agent-owned repair instructions.
- Add optional PagerDuty Stocks monitoring with restart-safe recovery. Activation
  requires the companion Stocks critical-health endpoint and private routing-key
  configuration; real trigger/resolve delivery is not yet verified.
- Publish verified beta artifacts through the shared trusted-publisher workflow.

- Add explicit host-owned shared-workspace access and serialize bindings to the
  same resolved repository path while retaining isolated task transcripts.
- Bound interactive Codex context through native compaction and expose
  content-free launch, execution and delivery timings.
- Support owner-approved Telegram text groups and ongoing incoming-only grants
  through restricted task execution; retain exact conversation/account authority.
- Preserve revocation recovery and uncertain-send receipts. Ongoing WhatsApp
  grants require the companion WhatsApp beta.13 provider.
- Fix graceful container shutdown, isolate CI package sources and await RPC
  fixture cleanup. Make verified release handoff proactive and agent-owned.
- Beta limits: no group media; live group-recipient and final fresh-host/reboot
  acceptance remain pending. No new live-delivery or latency claims.
- Default core and plugin automatic updates to the beta channel; preserve saved
  stable-only and manual policies.

## 0.1.0-beta.13

- Escalate cancelled plugin clients and report container cleanup failures.
- List the GitHub CLI plugin in the public catalog.
- Include standalone CLI, native task runtime and integration discovery updates.

- Support incoming-only reply tasks without an opening message; refresh installed
  guidance for selective setup, implicit follow-up, and quiet account linking.

- Add owner-approved, single-contact messaging tasks, core-bound sends and notes,
  fresh restricted Codex execution, revocation/expiry, and durable uncertain sends.
- Task execution requires audited Codex 0.153.4 and a message-v1 event source.
  Other external events remain blocked; live provider acceptance is pending.


- Add optional per-command exposure declarations and `ez tools exposure` with
  conservative defaults. Declarations do not grant authority.
- Block registered external events before owner-runtime execution; keep durable
  blocked records visible in work status. This disables prior external wakeups
  until an isolated runner exists. Recheck active paired-owner provenance at
  the local and host launch boundaries.

## 0.1.0-beta.12 — self-upgrade beta

- Agent-owned main/plugin upgrades with stable-default policy, queued maintenance,
  pinned package-manager preflight, private backups and code/config rollback.
- Main Telegram onboarding before plugin installation, reusable build/preflight tools,
  executor and private-pause fixes, and installed/running version diagnostics.
- Isolated worktree/PR contribution process and explicit independent review.
- User-reported VM QA passed main beta.3 to beta.4 upgrade and deliberate beta.11
  activation failure with rollback to beta.4 and a post-recovery Telegram reply.
- That VM evidence covers earlier candidates. Final beta.12 fresh-host/reboot and
  live WhatsApp upgrade acceptance remain pending; this is a testing beta.

Private QA versions beta.3 through beta.11 were not public releases; some were
deliberately broken rollback fixtures and must never be published.

## 0.1.0-beta.2 — distribution preparation (not published)

- Publish under `@jc_stack/ez-agents`; GitHub remains `jdorado/ez-agents`.
- Document pinned npm downloads and retain the beta-only distribution channel.
- Runtime behavior and dependencies are unchanged from beta.1. Live account and
  reboot acceptance remain deferred.

## 0.1.0-beta.1 — initial public beta

- Owner-paired Telegram relay using an existing host AI CLI and persistent
  Markdown workspace, with queued execution and explicit messaging tools.
- Docker runtime, private deployment creation and a local hash-pinned plugin
  manager with explicit installation/start/stop and provider-owned onboarding.
- Empty default catalog: no unpublished sibling package required.
- Public contribution, security, packaging and release instructions.

Limits: trusted host administration, not hostile-agent isolation. No hosted
service or remote plugin marketplace. Desktop executor acceptance and optional
voice providers need separate verification; CLI success is not GUI evidence.

Beta acceptance: automated tests, packed installs and Docker fixtures only. Live
provider onboarding and reboot verification are deferred, not marked passed.
