# ezenciel-agents — Coding Standards & Architectural Invariants

Ez supports two independent, composable uses: an autonomous Telegram agent and
workspace-scoped plugins called by your existing local CLI/GUI executor.
The autonomous agent also supports authenticated application channels without
Telegram; see docs/application-channel.md. One installation owner can link several
channels. Channel credentials and reply destinations do not create new owners.
For CLI-only requests, follow [standalone setup](docs/standalone-cli.md): no Telegram
pairing, relay or host executor is required. The main-first Telegram onboarding
rules below apply only when installing the autonomous relay. When both are
requested, keep each workspace's authority and registry explicit.

Installed runtime operation uses Docker Compose. Read
[Docker setup, state and QA](docs/docker-runtime.md). Docker owns relay/plugin services; the existing host CLI and login are shared
through one generic transport, with separate agent workspaces and sessions.

## Operating-agent instructions

Do not inject a coding handbook into production agent minds. The package-owned
workspace locator is the managed `<!-- ez tools -->` block: the bound `ez`
launcher, `ez --help`, and `ez tools list --details`. Inventory is generated on
read; do not hardcode command recipes. Purpose lives in that agent's own
`AGENTS.md`. Coding defaults for this repository stay in this file and
CONTRIBUTING.md.

## Installing this package

When the user asks to set up or install this repository or package, follow
[the agent-led setup instructions](docs/setup.md). Handle the technical work
and ask only for missing information. The user does not need to name or read
the documentation. Install means onboarding through a real Telegram reply,
unless the user explicitly asks for package files only. Do not finish with
developer commands or an uninitialized bot. At a required user step, give one
concrete action with its exact link; continue after their answer. The coding
standards below apply when developing the relay.

Main-first onboarding is mandatory: initialize an empty registry, complete owner
pairing and verify an agent-produced Telegram reply before plugin preparation or
QR onboarding. A supplied plugin archive is deferred input. After main setup,
plugin requests and onboarding run through the installed agent's Telegram chat,
not the original installer CLI. Read docs/setup.md for the handoff and diagnostics.

This package will be published as an open-source, lightweight Telegram-to-CLI relay. All code added to this package must adhere to these strict invariants to prevent bloat, credential leaks, and rewrites.

---

## 1. Radical Lean Footprint (Zero DB Dependencies)
- **Runtime dependencies:** Restricted to `grammy` and TypeScript tooling (`tsx`). Do not add databases (no MongoDB, SQLite, Redis, or ORMs) or web frameworks (no Express/Fastify).
- **Native Node 22+ APIs only:** Use `node:fs/promises`, `node:child_process`, `node:crypto`, `node:path`, and native global `fetch`, `FormData`, and `Blob`.
- Keep `node_modules` minimal and installable in seconds.

## 2. The engine is the core; ez is an ultra-lean gate
- The selected CLI/GUI engine owns intelligence, context, reasoning, planning, goals, delegation and continuation. ez mainly authorizes inputs, invokes engines/tools and transports results. Keep necessary queue ownership, cancellation, secret isolation and reliable delivery deterministic.
- Plugins are ordinary CLI tools with explicit inputs, outputs and errors. Packaging a tool does not justify another LLM worker or business workflow owner.
- **SUBTRACT is as valid as ADD.** Question the requirement; delete unnecessary behavior; simplify; shorten feedback; automate last. Name and try the subtraction option before proposing additions. Removing a wrapper or correcting existing engine instructions/tool contracts can be the complete fix.
- Add code only for a demonstrated missing transport or tool capability. Prompts, agents, retries and lifecycle owners also count as machinery; do not replace deleted code with a scripted prompt workflow. Prefer existing engine, CLI and Docker capabilities.
- The spawn core (`src/executor.ts` `startExecutorJob`) is spawn + stream only: callers own admission/authority and pass the one trigger suffix; the core never reads the run ledger, history or the workspace.
- `/goal do my daily routine` is literal task-prompt text for the engine. ez does not parse it, construct a native objective or own its workflow.
- Keep changes focused. State what was removed, why anything added is necessary, and which observed outcome proves the simpler system works. Preserve authority and uncertain-delivery safeguards. Unchanged, non-actionable maintenance stops quietly; queued updates and passing tests alone do not prove an installed fix.

## Fast KISS iterations

Deliver the smallest useful product increment and verify its main user path.
Once that works within the architecture and authority boundaries, complete the
authorized delivery instead of spending disproportionate effort on rare,
low-impact edge cases. Prefer fast feedback and a focused follow-up fix over
speculative abstractions, fallback layers or exhaustive test matrices.

Scale validation to likelihood, impact and reversibility: test the changed
behavior and relevant failure boundaries, run required checks, then stop when
they pass. Broaden testing only for a concrete unresolved risk or new failure.
Architecture violations, authorization/secret exposure, data loss and uncertain
external writes remain blockers even when rare; minor recoverable limitations
can be stated briefly and deferred. Reviewers distinguish those blockers from
optional follow-ups and do not hold a working increment for hypothetical polish.
Measure progress by usable outcomes and feedback, not code or test volume.

## Feasibility frame for non-trivial work

Before implementing a non-trivial coding, architecture or product change, state
the user-visible objective, no more than five task-relevant binding constraints,
the component that owns the failed boundary, the subtraction or simplification
option, the minimum evidence needed to prove the outcome, and the stop condition.
Do not restate the full prompt or add this ceremony to minor mechanical edits.

A result that violates a binding constraint is invalid even when tests pass or
the immediate symptom disappears. Check behavioral correctness, architecture and
ownership, real user-path evidence and authorized side effects separately. Before
completion, inspect whether the change added a runner, wrapper, state owner, queue,
retry loop, prompt layer, dependency or configuration format; retain it only when
the existing owner or contract cannot solve the demonstrated problem. Use one
bounded constraint review, then stop when sufficient evidence passes unless a
concrete material risk remains.

Frame that review as answers to these questions, not as an open-ended request to
find flaws:

1. Did the solution cross an architecture, ownership or authority boundary?
2. Did it bypass a binding constraint or preserve the symptom through a workaround?
3. Did it add machinery where deletion or a simpler existing contract would work?
4. Does the evidence prove the real user-visible outcome rather than only a proxy?
5. Is there one concrete unresolved risk severe enough to block completion?

If no answer identifies a material blocker, finish. Do not start another review
round merely to seek more criticism, tests or hypothetical edge cases.

## 3. Crash-Safe Disk State
- Persistent authority state (`ControlStore` owner/pairing/sessions/presets, application bindings, schedule definitions) stays in disk-backed JSON files. Run/outbox/inbox bookkeeping is relay memory reached through the delivery socket (`src/delivery-socket.ts`): a restart drops in-flight runs and queued deliveries by design, uncertain sends report unknown rather than success, and Telegram redelivery is the replay mechanism. The live delivery socket also replaces the relay flock as the single-relay guard.
- **Atomic write pattern:** Never write directly to a state file. Always write to a temporary file (`${target}.${process.pid}.tmp`) with mode `0o600`, then atomically `rename` it over the destination.
- **Path sanitization:** Every ID parameter (`runId`, `outboxId`, `pairingId`) must be validated against `/^[a-zA-Z0-9_-]+$/` before being joined into paths. Never allow directory traversal (`..`).

## 4. Strict Subprocess Isolation & Secret Whitelisting
- **Environment leak prevention:** `TELEGRAM_BOT_TOKEN`, relay internals, and parent daemon secrets must **never** leak into the executor subprocess.
- The executor environment is built from an explicit whitelist plus bound runtime identifiers. Inspect `src/executor.ts` for the current list; never spread the daemon environment into a child.
- Executor stdout is ignored for chat delivery. To send updates, the agent must invoke the native binary: `ezenciel-agents-message`.

## 5. Telegram Formatting & Rate Limit Safety
- **Safe HTML formatting:** Never pass raw markdown directly into Telegram with `parse_mode: 'HTML'` or `'MarkdownV2'` without escaping. Use a dedicated sanitizer (`markdownToTelegramHtml`) that escapes `<, >, &` before wrapping tags.
- **Message chunking:** Chunk all outgoing messages to $\le 4,000$ characters on paragraph (`\n\n`), line (`\n`), or word boundaries.
- **Rate limits:** Avoid spamming bubbles to respect Telegram’s 1 message/sec per-chat rate limit.

## 6. Concurrency & Workspace Invariants
- **1 Writer Job per Workspace:** The agent's Markdown folder (`./agent/`) is its mind. Never run concurrent background processes writing to the same workspace simultaneously.
- Main-conversation jobs queue sequentially in the relay's memory ledger; the delivery socket carries every cross-process enqueue/receipt, never control/ files. Scheduled/background work uses separate task directories under the control directory and native CLI sessions (up to four alongside chat). Never share a mutable task directory. Delegation decisions and goal persistence belong to the agent/executor; there is no automatic planner or canned chat ACK. Production executor runs have no wall-clock timeout; cancellation is explicit.

## 7. Fail-Closed Authority (Channel Access ≠ Execution)
- Incoming messages outside the approved owner binding must **never** spawn the executor. A first DM or group message records a pending request only. Explicitly approved owner groups grant owner access to all human members in that exact chat; bots and anonymous posts are ignored.
- Unapproved group messages from other senders and unknown DMs fail silently unless an exact-contact or any-conversation owner-approved channel grant admits them. Both grant types use the restricted task runner. Paired-owner group text is discovery routed to the owner's private chat; it grants no group reply authority.
- Stopping work (`/stop`) must terminate the active worker PID immediately (`SIGTERM`, escalating to `SIGKILL` if unclosed after 3s).

## 8. Risk-based negative validation

Changes to authority, execution, routing, secret isolation or durable state must
validate the affected failure boundary, not rerun or recreate an unrelated fixed
checklist. Examples include proving that an unapproved sender spawns no process,
executor secrets remain absent, invalid IDs cannot traverse paths, ambiguous
external writes are not retried, and corrupt state fails safely. Add or change a
test only when it protects the changed contract or a demonstrated regression.
Existing relevant checks plus focused real-path evidence may be sufficient.

## Public contribution workflow

Read CONTRIBUTING.md before edits and docs/releasing.md before a release. It owns
the worktree, PR, review, merge, release and cleanup process; do not duplicate that
process here or in feature documentation. For every core or plugin change, apply
its architecture check and the README's engine/application boundary. A symptom
fix and green tests do not justify a conflicting execution or context owner.
Existing legacy channel-backend code is a documented limitation, not a pattern
for new integrations. Keep internal plans and private evidence outside this
repository.

Source-checkout image builds are RCs: commit and open the PR first, then
`ezenciel-agents-install build --label X.Y.Z-beta.N.rc.M` (increasing `.rc.N`)
from the clean reviewed commit. The build refuses a dirty checkout and an
unlabeled build installs a fallback label; `/status` must show the RC tag first.
