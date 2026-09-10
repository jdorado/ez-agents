# Changelog

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
