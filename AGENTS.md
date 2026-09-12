# ezenciel-agents — Coding Standards & Architectural Invariants

Ez supports two independent, composable uses: an autonomous Telegram agent and
workspace-scoped plugins called by your existing local CLI/GUI executor.
For CLI-only requests, follow [standalone setup](docs/standalone-cli.md): no Telegram
pairing, relay or host executor is required. The main-first Telegram onboarding
rules below apply only when installing the autonomous relay. When both are
requested, keep each workspace's authority and registry explicit.

Installed runtime operation uses Docker Compose. Read
[Docker setup, state and QA](docs/docker-runtime.md). Docker owns relay/plugin services; the existing host CLI and login are shared
through one generic transport, with separate agent workspaces and sessions.

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

## 2. KISS and first-principles engineering
- Before coding: identify the user outcome and reproduce the failed boundary. Question requirements; delete unnecessary behavior; simplify; shorten feedback; automate last.
- The relay owns deterministic authorization, atomic state, queues, cancellation and safe delivery. The executor owns reasoning, business workflows, tool selection and conversation. Do not replace transport safeguards with agent judgment.
- Prompts and wakeups count as control logic. Remove conflicting mandates, duplicate lifecycle owners and self-feeding maintenance before adding retries or another abstraction. Plugins remain standalone CLIs behind generic transport.
- Prefer existing executor, CLI and Docker capabilities. Every retry needs a recoverable condition or an explicit bound; unchanged blocked maintenance stops quietly until evidence or authority changes.
- Keep changes focused. State the cause, what was removed, why remaining code is needed, and the observed outcome. Verify the actual failure boundary and relevant negative case; passing tests, queued updates and more betas alone do not prove delivery or an installed fix.

## 3. Crash-Safe Atomic Disk State
- All persistent stores (`ControlStore`, `RunStore`, outbox queue) must be disk-backed JSON files.
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
- Main-conversation jobs queue sequentially in `RunStore`. Scheduled/background work uses separate task directories and native CLI sessions (up to four alongside chat). Never share a mutable task directory. Delegation decisions and goal persistence belong to the agent/executor; there is no automatic planner or canned chat ACK. Production executor runs have no wall-clock timeout; cancellation is explicit.

## 7. Fail-Closed Authority (Channel Access ≠ Execution)
- Incoming messages outside the approved owner binding must **never** spawn the executor. A first DM or group message records a pending request only. Explicitly approved owner groups grant owner access to all human members in that exact chat; bots and anonymous posts are ignored.
- Unapproved group messages from other senders and unknown DMs fail silently. Approved group text uses the existing conversation grant and restricted task runner. Paired-owner group text is discovery routed to the owner's private chat; it grants no group reply authority.
- Stopping work (`/stop`) must terminate the active worker PID immediately (`SIGTERM`, escalating to `SIGKILL` if unclosed after 3s).

## 8. Mandatory Adversarial & Negative Tests
Every pull request modifying authority, execution, or routing must include negative tests:
1. Unapproved Telegram ID $\rightarrow$ no process spawned.
2. Non-owner group message $\rightarrow$ silent ignore; owner group discovery $\rightarrow$ private destination only.
3. Executor environment check $\rightarrow$ asserts `TELEGRAM_BOT_TOKEN` is `undefined`.
4. Corrupt JSON in store $\rightarrow$ handled gracefully without process crash.
5. Injected path traversal in IDs $\rightarrow$ rejected.

## Public contribution workflow

Read CONTRIBUTING.md before edits and docs/releasing.md before a release.
Maintainers and external agents use the same PR, tests and documentation standard.
Keep internal plans and private evidence outside this repository.

Before edits, follow CONTRIBUTING.md's isolated-work rules: one task per dedicated
worktree/branch/PR, starting from fetched origin/main. Do not switch or mix work in
another task's checkout. Stage only this task's changes. Keep its worktree through
review and QA; independent review and green CI precede an authorized merge.
Never treat task completion as permission to merge or publish.
Own the complete engineering/release handoff in CONTRIBUTING.md. Once ready,
proactively request only missing merge/release authority, then ship and verify;
do not leave the maintainer to discover ready drafts or operate the release.

- In channel-backend mode, the application owns native sessions and actions. Forward normalized inputs with stable run IDs, recover only by idempotent backend submission, and deliver replies through the existing outbox. Never launch a fallback CLI or pass relay credentials into an executor.

A coding-task handoff must include the pushed commit and draft PR URL, checks,
independent-review status and remaining QA. If PR creation is blocked, state the
blocker and preserved commit. The merging agent owns the post-merge worktree
cleanup check and reports removal or the specific reason to retain it. Follow
CONTRIBUTING.md for squash-merge evidence, ignored files and active-use checks.
