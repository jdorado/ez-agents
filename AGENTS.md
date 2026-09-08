# ezenciel-agents — Coding Standards & Architectural Invariants

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

This package will be published as an open-source, lightweight Telegram-to-CLI relay. All code added to this package must adhere to these strict invariants to prevent bloat, credential leaks, and rewrites.

---

## 1. Radical Lean Footprint (Zero DB Dependencies)
- **Runtime dependencies:** Restricted to `grammy` and TypeScript tooling (`tsx`). Do not add databases (no MongoDB, SQLite, Redis, or ORMs) or web frameworks (no Express/Fastify).
- **Native Node 22+ APIs only:** Use `node:fs/promises`, `node:child_process`, `node:crypto`, `node:path`, and native global `fetch`, `FormData`, and `Blob`.
- Keep `node_modules` minimal and installable in seconds.

## 2. Zero Deterministic Coding Across the Board (Tools, Flows & Dialog)
- **The relay is dumb plumbing:** The relay only ingests messages, batches them into runs, spawns the CLI executor, and drains outbox items. It is strictly minimal.
- **Nothing deterministic—not just dialog:** Do not hardcode multi-step tool pipelines, fallback state machines, parameter translation shims, procedural dialog flows, or canned conversational receipts ("Started run...", "I'll message as I go...").
- **The debugging reflex trap:** When an integration, tool, or flow doesn't work as expected, developers and LLMs have an overwhelming reflex to patch it by writing deterministic procedural code (`if error X -> hardcode Y -> do Z`). **Resist this completely.**
- **The real engineering work:** Our job is solely to:
  1. Build clean, standalone tools that work reliably with clear Unix interfaces (clear args, predictable stdout/stderr, clean exit codes).
  2. Ensure tools have simple setup and are clearly explained in the agent's workspace so the **agent understands them**.
  3. Let the agent own all flow orchestration, tool chaining, decision making, and error recovery. Question every line of code—if it can be agentic, keep code out of it.

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
- Executor jobs queue sequentially in `RunStore`; the poller remains available for cancellation and incoming messages. There is no separate planner or automatic chat ACK lane.

## 7. Fail-Closed Authority (Channel Access ≠ Execution)
- Incoming messages from unapproved senders must **never** spawn the executor. First DM registers an unapproved pairing request, then stops.
- Group messages or unknown DMs fail silently.
- Stopping work (`/stop`) must terminate the active worker PID immediately (`SIGTERM`, escalating to `SIGKILL` if unclosed after 3s).

## 8. Mandatory Adversarial & Negative Tests
Every pull request modifying authority, execution, or routing must include negative tests:
1. Unapproved Telegram ID $\rightarrow$ no process spawned.
2. Group message $\rightarrow$ silent ignore.
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
