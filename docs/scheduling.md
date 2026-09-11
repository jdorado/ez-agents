# Scheduling and background work

Ask the agent naturally: “Remind me on September 9 next year at 09:00 Dubai time”
or “Every Tuesday at 09:00, prepare the report.” The agent translates this into a
core CLI request. No plugin, database or operating-system cron setup is required.

```sh
ezenciel-agents-schedule create --name Reminder \
  --at 2027-09-09T09:00:00+04:00 --text 'Remind the owner about the renewal.'
ezenciel-agents-schedule create --name Weekdays \
  --cron '0 9 * * 1-5' --timezone Asia/Dubai --text 'Prepare the daily report.'
ezenciel-agents-schedule create --name Research --now \
  --text '/goal Complete the authorized research objective. Save evidence, verify the outcome, and send the owner the result.'
ezenciel-agents-schedule list
ezenciel-agents-schedule runs
ezenciel-agents-schedule pause SCHEDULE_ID
ezenciel-agents-schedule resume SCHEDULE_ID
ezenciel-agents-schedule remove SCHEDULE_ID
ezenciel-agents-schedule cancel RUN_ID
```

Use `--text-file` for longer instructions. `edit ID` replaces the complete schedule
with a new revision; use the same trigger/name/text flags as `create`.
Intervals use `--every-seconds` (minimum 60), optional `--start`, and optional
`--until`. Cron also supports start/end bounds. All absolute timestamps require
an explicit offset. `--now` starts on the next relay tick, not synchronously.

Cron accepts five numeric fields, comma lists, ranges and steps; Sunday is 0 or 7.
Restricted day-of-month and weekday fields use standard OR semantics. Set just
weekday for “Tuesdays.” Calendar jobs retain their explicit IANA timezone when
the host changes zones. Nonexistent DST wall times are skipped; repeated wall
times fire once, at the earlier instant. Search is bounded to eight years.
Public-holiday calendars and arbitrary RRULE syntax are not implemented.

New tasks, including work deferred by a busy reply session, default to Codex
`gpt-5.6-terra` with `high` reasoning independently of the creating chat.
New chats use the separate Sol/medium preset. Busy reply `defer` accepts optional
`model` and `effort` fields; retries preserve the first saved task choice.
Use `--cli`, `--model`, and `--effort` to specify another choice. `xhigh` is
available only with Codex `gpt-5.6-luna`; every other model remains capped at
`high`. Non-Codex adapters inherit native effort when unset. Editing preserves the existing AI
choice unless those flags override it. Stored choices are checked again at
launch, including schedules saved before a policy change.

## Execution and authority

The relay checks due work once per second. Each occurrence enters the durable
run queue with a stable ID. Background work runs in a fresh native CLI session
and `work/tasks/RUN_ID/`, with snapshots of the agent's SOUL, USER and TOOLS files.
Instructions must include any needed context or source paths; full chat history
is not copied. Task folders remain for inspection and artifact delivery.

One writer runs per task directory. Up to four background tasks can run alongside
the main conversation. When a Codex owner message arrives while work is busy, a separate restricted session reads recent messages and run progress and answers through the normal outbox. It can queue requested work through the scheduler, but cannot run shell commands, access plugins, or edit the agent workspace. Only one reply session runs at a time and it releases its slot after a 60-second reply deadline; this deadline does not apply to writer jobs. Its context is a bounded snapshot, not a shared native transcript. Delivered parallel replies are included as historical context in the next normal conversation turn. Codex 0.153.4 and 0.154.0 are supported for this restricted adapter. Other versions fail closed pending tool-surface validation. A recurring schedule has at most one pending
or active occurrence. Agents should delegate long work with `create --now`, return
to chat, and inspect `runs` or task progress when asked. Native subagents can be
used inside the worker. Sharing provider profiles does not make concurrent CRM,
file or browser writes safe: the agent must coordinate those resources.

Production relay/host execution has no wall-clock timeout. The old
`EZ_EXECUTOR_TIMEOUT_SECONDS` setting is ignored. Individual network/tool waits
still have their own limits; those are not overall task deadlines. Native goals
are an executor capability, configured through instructions. Ez has no goal API,
continuation loop or rule equating a process exit with goal achievement.

Scheduled Codex CLI tasks use a dedicated native app-server session, tested with
CLI 0.153.4. A leading `/goal` in the instruction text maps to the same native
goal command used by the interactive CLI. Codex automatically starts subsequent
turns; the transport stays connected until the native goal is complete or stops
for attention. It sends no continuation prompts and stores no Ez goal state.
Goals created by the agent's native tools also keep the session alive. Ordinary
tasks finish after their turn. A blocked, paused or limited goal is not reported
as successful. Native RPC requests have a response deadline; running tasks do not.
Each scheduled task has its own Codex state under `control/cli/codex/tasks/RUN_ID`,
with a snapshot of the agent's Codex configuration and the existing auth link.
Foreground chat and background tasks do not initialize or migrate one shared
native database concurrently.

The foreground chat still uses `codex exec`. That invocation exits after one
requested turn even if a goal is active, so delegate persistent work to the
scheduler. Desktop and other executor goal lifecycles need separate validation.

The CLI binds jobs to the paired owner and the task AI choice. Queued/scheduled
work retains that choice after the chat switches AI. Revoking/re-pairing an
owner invalidates their old schedules, including re-pairing the same Telegram ID.
External event turns cannot use the scheduling CLI. Credentials still pass only
through the existing whitelist and installed host binding.

## Restart, pause and cancellation

Schedule definitions and cursors use protected atomic JSON files. A restart
between queue creation and cursor persistence does not duplicate an occurrence.
An overdue one-time job runs on return. Missed recurring occurrences coalesce into
one pending run; future runs resume at the next eligible time. A paused queued
occurrence waits for resume. Editing/removing a schedule invalidates its old
queued occurrence; already-running work continues until explicitly cancelled.

`/stop` stops all active work; `cancel RUN_ID` stops one background task. `/cancel`
clears queued work. Pause/remove a recurring schedule to prevent future runs.
Stopping the relay also stops its workers. A crashed or interrupted execution is
not automatically replayed. Status labels failed runs as history and shows recent reasons; new failures retain their exit code or interruption cause. Typing indicators stop after 30 seconds even when work continues. Runs found active at startup are marked failed with
`interrupted: true`; their schedule revision stays held until the agent inspects
the evidence and explicitly edits the schedule. Inspect the task's files, native session and delivery
receipts before deciding whether to resume. A clock cannot reconstruct an
in-flight process or prove whether an external side effect happened.

The host and relay must be online. Paused/completed schedule definitions and task
artifacts are retained. The agent sends through the normal Telegram outbox;
`completed` means executor exit, while provider delivery is recorded separately.
A timeout or ambiguous send must not cause blind replay of the whole task.

## QA

`pnpm verify` covers recurrence/DST, restart deduplication, authority revocation,
corrupt state, paths, cancellation and a chat response while a synthetic worker
is active. Docker tests exercise the packaged host transport and isolation.

For an opt-in real CLI probe (consumes model usage):

```sh
pnpm smoke:scheduler -- 1860 codex
# Native goal must finish a first turn and continue without another prompt:
pnpm smoke:scheduler -- 45 codex goal
```

This uses temporary workspaces and a synthetic Telegram provider, never live
contacts. A real CLI waits 31 minutes while a second invocation answers 17 × 19.
It checks responsiveness again after six minutes and requires the worker's final
message. Evidence is saved in the printed temporary directory. Use `75 codex`
for a shorter iteration; it does not prove the full duration.

Before enabling on a real installation, repeat through its Telegram bot: request
the 31-minute task, ask the arithmetic question and request status after six
minutes. Verify `finished.txt` and exactly one completion in Telegram. Separately
exercise cancellation, downtime catch-up and an explicitly requested native goal
that needs more than one turn. Synthetic provider evidence does not prove real
Telegram delivery, and a sleep test does not prove native goal persistence.

Busy-chat regression probe (real Codex, synthetic Telegram):

```sh
pnpm exec tsx scripts/smoke-busy-reply.ts --transport
```

The probe holds a writer on a shared workspace, asks an owner question through
the relay and host transport, and requires the restricted reply to complete
while the writer remains active. It sends no real Telegram messages.

## Optional failure review

Create a normal recurring schedule with `--every-seconds 900 --when unreviewed-failures --text-file templates/failure-review.md`. The condition advances empty occurrences without launching an executor. It considers only failures belonging to the paired owner. No separate monitor or automatic retry is introduced.

`failures [--all] [--limit N]` returns failedAt, reason, exit code, native session, captured error and runtime versions. Capture keeps at most 4 KiB of redacted stderr; historical failures are not backfilled. `run RUN_ID` reads an owned run. `review RUN_ID --failed-at ISO --status resolved|attention --diagnosis TEXT --recovery TEXT --outcome TEXT` records the investigation without rewriting execution history. A stale timestamp is rejected; a later failure needs a new review. Restricted reply, external and isolated-task callers cannot review failures. An attention review is handed off, not repeatedly relaunched; another new failure wakes the next review.

The prompt controls diagnosis, authorized recovery and quiet notification behavior. Inspect prior effects and receipts before retrying anything. A failed review run itself remains visible as a new failure for the next occurrence.
