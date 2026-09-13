# Changelog

## Unreleased

- Add named Telegram conversations with switching, renaming, archiving and
  restoring. Preserve native engine bindings and queued work across switches.

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
