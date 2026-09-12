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

New tasks inherit selected engine settings. Explicit `--cli`, `--model` and
`--effort` override those choices; omitted values use native defaults. Edits
preserve existing choices. Historical deferred tasks keep their source context
available through `ezenciel-agents-schedule context`.

## Execution and authority

Due occurrences enter the durable queue with stable IDs and literal task text.
Background runs use fresh native sessions in `work/tasks/RUN_ID/`. No identity
files or role instructions are generated there. Existing workspace Markdown
provides context; the engine chooses what to read. Task folders remain for
inspection and artifact delivery.

One writer runs per task directory. Up to four background tasks can run alongside
the main conversation. Foreground inputs queue while a foreground turn runs;
ez does not create another reply agent. The agent can delegate or schedule long
work and return to chat. It decides when to send through the message CLI.
A recurring schedule has at most one pending or active occurrence. Shared
provider resources still need writer coordination.

Production relay/host execution has no wall-clock timeout. The old
`EZ_EXECUTOR_TIMEOUT_SECONDS` setting is ignored. Individual network/tool waits
still have their own limits; those are not overall task deadlines. Native goals
are an executor capability, configured through instructions. Ez has no goal API,
continuation loop or rule equating a process exit with goal achievement.

Scheduled Codex CLI tasks use a dedicated native app-server session, tested with
CLI 0.153.4. Ez forwards the full task as ordinary input without interpreting
`/goal` or constructing a native goal objective. The engine handles the request,
context and native goal creation. Codex owns continuation; the transport stays
connected while a native goal is active and verifies its terminal state. It sends
no continuation prompts and stores no Ez goal state. Ordinary tasks finish when
the engine completes its turn without an active goal. A blocked, paused or limited
goal is not reported as successful. Native RPC requests have a response deadline;
running tasks do not.
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

## Failure-review stop

A schedule using `--when unreviewed-failures` stops dispatching its current
revision after one of its own runs fails. The failed receipt remains available
through `runs`/`run`; no new retry queue or automatic repair task is created.
The paired owner or authorized maintainer diagnoses it and explicitly edits the
schedule to resume. Marking the failure reviewed or pause/resume alone does not
clear the stop. Ordinary recurring tasks retain their existing failure behavior.

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

## Optional failure review

Create a normal recurring schedule with `--every-seconds 900 --when unreviewed-failures --text-file templates/failure-review.md`. The condition advances empty occurrences without launching an executor. It considers only failures belonging to the paired owner. No separate monitor or automatic retry is introduced.

`failures [--all] [--limit N]` returns failedAt, reason, exit code, native session, captured error and runtime versions. Capture keeps at most 4 KiB of redacted stderr; historical failures are not backfilled. `run RUN_ID` reads an owned run. `review RUN_ID --failed-at ISO --status resolved|attention --diagnosis TEXT --recovery TEXT --outcome TEXT` records the investigation without rewriting execution history. A stale timestamp is rejected; a later failure needs a new review. Restricted reply, external and isolated-task callers cannot review failures. An attention review is handed off, not repeatedly relaunched; another new failure wakes the next review.

The prompt controls diagnosis, authorized recovery and quiet notification behavior. Inspect prior effects and receipts before retrying anything. A failed review run itself remains visible as a new failure for the next occurrence.

The Telegram Scheduled tasks menu lists enabled schedules that still have a pending
occurrence or a queued/running occurrence. Finished one-time tasks, paused
schedules and revisions stopped for review are hidden. Each entry shows the
effective engine/model/effort, next occurrence in UTC (or queued/running state),
and the first sentence of its saved invocation
prompt, limited to 140 characters. This is a read-only view; history and full
prompts remain available through the scheduling CLI.
