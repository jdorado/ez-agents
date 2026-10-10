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
ezenciel-agents-schedule trigger SCHEDULE_ID --key owner-smoke-20261003
ezenciel-agents-schedule pause SCHEDULE_ID
ezenciel-agents-schedule resume SCHEDULE_ID
ezenciel-agents-schedule remove SCHEDULE_ID
ezenciel-agents-schedule cancel RUN_ID
```

Use `--text-file` for longer instructions. `edit ID` replaces the complete schedule
with a new revision; use the same trigger/name/text flags as `create`. It keeps
the paused/enabled state: an edited paused task stays paused until `resume`.
An edit keeps a future pending occurrence when its trigger is unchanged;
otherwise the edited rule begins at its next future occurrence. Editing does
not replay missed work from an old start date. Use `--now` to request a new
one-time run explicitly. `show` reports the pending occurrence used by dispatch.
Intervals use `--every-seconds` (minimum 60), optional `--start`, and optional
`--until`. Cron also supports start/end bounds. All absolute timestamps require
an explicit offset. `--now` starts on the next relay tick, not synchronously.

Cron accepts five numeric fields, comma lists, ranges and steps; Sunday is 0 or 7.
Restricted day-of-month and weekday fields use standard OR semantics. Set just
weekday for “Tuesdays.” Calendar jobs retain their explicit IANA timezone when
the host changes zones. Nonexistent DST wall times are skipped; repeated wall
times fire once, at the earlier instant. Search is bounded to eight years.
Public-holiday calendars and arbitrary RRULE syntax are not implemented.

New tasks capture selected engine settings. Explicit `--cli`, `--model` and
`--effort` override those choices. Edits preserve existing choices.
Core always passes the task's concrete saved model. Creation and edits
require a model in the captured settings or an explicit `--model`; missing models
are rejected. Legacy tasks with no saved model remain inspectable, but dispatch
and executor admission refuse to run them until they are explicitly configured.
Chat changes and native defaults never supply a missing model at run time.
To run an existing task outside its cadence, use `trigger ID --key REQUEST_KEY`: it queues
the task's saved instructions, engine, model, effort and delivery binding in a
fresh session, without changing its definition or next regular occurrence.
Model/text/trigger overrides are rejected. Reuse the same request key after an
uncertain response; it reads back the same run while the relay retains it.
After a relay restart, inspect native history and provider/canonical receipts
before issuing another request: the run ledger remains intentionally in memory.
Paused, stale-owner, overlapping or held tasks and unmet conditions cannot be
triggered. Historical deferred tasks keep their source context
available through `ezenciel-agents-schedule context`.

## Ordered setup fallback

An agent task may list ordered fallback setups after its saved one, for
example `claude · opus → claude · sonnet → codex · gpt-6-sol`:

```sh
ezenciel-agents-schedule create --name Daily --cli claude --model opus \
  --cron '0 9 * * *' --timezone Asia/Dubai --text 'Prepare the daily report.' \
  --fallback cli=claude,model=sonnet,effort=medium --fallback cli=codex,model=gpt-6-sol
```

`edit` keeps the saved fallbacks unless `--fallback` replaces them or
`--clear-fallbacks` removes them. Setups must be distinct and each needs a model.
There is no fixed list-length limit. Each setup captures its own supported CLI,
model, effort and optional provider; the installed native client owns valid model
and effort values. The existing failure rules below apply to every setup.
Each fallback may include `auth-profile=NAME` to select its own owner-provisioned
Codex or Claude account. Omitting it selects the default login, independently of
the primary setup. For four separate Claude accounts, provision and log into
`claude2`, `claude3` and `claude4`, then use:

```sh
ezenciel-agents-schedule create --name Daily --cli claude --model opus \
  --cron '0 9 * * *' --timezone Asia/Dubai --text 'Prepare the daily report.' \
  --fallback cli=claude,model=opus,auth-profile=claude2 \
  --fallback cli=claude,model=opus,auth-profile=claude3 \
  --fallback cli=claude,model=opus,auth-profile=claude4
```

Core advances to the next setup only with typed evidence that nothing ran: the
CLI is not installed or executable, or the provider rejected the turn before any
model output, tool or hook item (quota/rate limit, billing, overload, server
error, unavailable model or bad request), including a missing, expired or revoked
login (typed authentication failure or HTTP401). Native API-error metadata does
not count as model/tool work. It stops, without replay, on access
denial (HTTP403, account or organization restriction), cancellation, relay shutdown,
a schedule edit, a policy or unknown error, an interrupted transport, or any
other failure after work began. Evidence comes from structured events only: Codex
native-session `codexErrorInfo` and Claude `stream-json` error fields (scheduled
Claude runs use `--output-format stream-json`; the host forwards only a compact
startup summary). Other engines advance only when their CLI is unavailable.

The one failure after work began that continues is a Claude usage limit the run
ended on (for example "You've hit your session limit"): a typed quota rejection
with no model, tool or hook activity after it. A native session cannot be resumed
under another login's configuration home, so the next eligible setup starts a fresh
session with the saved prompt plus one factual line naming the run, the stopped
setup, its native session and reset time, and that its work may be partly applied.
The agent reconciles from its own records; core replays nothing else.

A login or quota rejection skips the remaining setups in the same scope: the native
client and login profile (`claude`, `codex` including desktop and custom Codex
providers), `grok`, or the upstream provider for OpenCode/Pi models. A named
profile selects a separate owner-provisioned account and is eligible for its own
attempt; changing only the model in the same profile does not reset its scope.
Do not provision aliases of the same account to obtain more allowance. Ez does
not infer account independence from credentials or promise that a shared
organization's allowance is separate. Each setup runs at most once per occurrence.

Every attempt keeps the same run ID, occurrence, schedule revision, workspace,
delivery binding and scheduled concurrency slot, in a fresh native session.
`run RUN_ID` shows `attempts`: each setup, quota scope, outcome, failure category
(`cli-unavailable`, `login-unavailable`, `quota`, `provider-rejected`, `access-denied`,
`quota-after-work-began`, `after-work-began`, `uncertain`, or `same-login-scope`/`same-quota-scope`
for a skipped setup), exit code, reported reset time and the session ID Ez assigned. If every setup is unavailable the run fails with
reason `setups-unavailable`, a summary of each setup, and an owner notice on
Telegram-bound tasks. Core never purchases credits, enables overage or consumes
reset credits; the next regular occurrence runs normally.

## Registered script schedules

A schedule has one execution type. **Agent** schedules run the saved prompt with
their saved engine, model and effort, as described below. **Script** schedules run
a registered, agent-owned script directly: no model, effort, prompt or native
session is involved.

```sh
ezenciel-agents-schedule script register book-freshness \
  --file scripts/book-freshness.mjs --interpreter node [--arg=VALUE ...] [--timeout-seconds 900]
ezenciel-agents-schedule create actual-book-freshness-guard \
  --script book-freshness [--arg=VALUE ...] --cron '15 * * * *' --timezone Asia/Dubai
ezenciel-agents-schedule script list | show ID | update ID [...] | remove ID
```

The agent writes, tests and maintains the script; core owns registration,
scheduling, authorization, process execution, cancellation and run receipts.
A registration records the owner binding, a workspace-relative entry point, an
installed interpreter (command name on the executor PATH or absolute path),
literal arguments, a timeout and the entry point's SHA-256 under a new revision.
It references the workspace file; core keeps no source copy. Paths outside the
workspace (including symlink escapes) and shell command strings are rejected.
Core invokes `interpreter entry registrationArgs... scheduleArgs...` directly,
without a shell. Missing interpreters fail clearly; nothing is installed.

When an occurrence is queued, the run captures the current registration
revision and hash. Immediately before spawning, the executor requires that
revision to be current and the entry-point bytes to match. Changed bytes fail
the run until the agent explicitly runs `script update`. The hash identifies the
entry-point file only; it does not certify imported modules or other files.

Script runs use the existing scheduler, admission queue, scheduled concurrency
limit, one-occurrence-per-schedule rule, run records, delivery binding, manual
`trigger`, pause/resume/edit/remove and `cancel`. They run in the agent's
isolated environment (relay or host transport) under its normal identity, with
the executor environment allowlist plus `EZ_RUN_ID`, `EZ_SCHEDULE_ID`,
`EZ_SCHEDULE_REVISION`, `EZ_DUE_AT`, `EZ_SCRIPT_ID`, `EZ_SCRIPT_REVISION` and
`EZ_SCRIPT_SHA256`. Use the run/schedule/due identifiers to form a stable
occurrence identity. External operations go through the bound plugin CLI; a
script must not read private databases, call providers directly or acquire
credentials. A script run can read schedule and script state but cannot change
registrations or schedules.

A script runs with the agent's runtime identity and file access, but not inside
a native engine's own sandbox (for example host Codex `workspace-write`); register
only code the agent would be allowed to run itself. An interpreter inside the
workspace is rejected because it would be unhashed code.

Each registration has a bounded timeout (default 900 seconds, maximum 21600)
that does not affect agent runs. Timeout and `cancel` stop the process and its
children. Failed, timed-out or interrupted script runs are not retried, do not
fall back to an LLM and do not start a debugging agent. Inspect them with
`runs`, `run RUN_ID`, `failures` and `evidence`: the run shows the script ID,
revision and hash, queue/start/finish clocks, exit code, cancellation/timeout,
failure reason and a 4 KiB redacted tail of stdout/stderr. Those records follow
the normal relay-memory retention. Stdout is diagnostic only. Process success
means the script exited 0; domain success still requires the owning plugin's
validation, receipt and canonical readback, which the script performs and
records. Notifications use `ezenciel-agents-message` under the normal policy;
routine unchanged runs should stay quiet.

Editing a schedule replaces it completely, so it may switch execution type.
When replacing an agent schedule with a script, move any judgment the prompt
performed to its owning workflow first; the script schedule does not carry it.

## Execution and authority

Due occurrences enter the durable queue with stable IDs and literal task text.
Owner-scheduled runs use fresh native sessions in the bound agent workspace.
No identity files or role instructions are generated. Existing workspace Markdown
provides context, including native `AGENTS.md` discovery and relative links; the
engine chooses what to read. Per-run native state stays under `control/`.

One foreground turn and up to six owner-scheduled turns can run at the same time.
Set `EZ_SCHEDULED_CONCURRENCY` to a positive integer to change the scheduled-job
limit; it defaults to six. For Docker deployments, put this setting in the
existing private relay environment file (`EZ_RELAY_ENV_FILE`); no Compose
layout migration is needed. Foreground inputs queue behind foreground work;
scheduled turns queue only when their limit is occupied. A long scheduled goal therefore does not block chat. Both streams
use the existing admission and executor path, with separate native sessions.
They share the agent-owned Markdown workspace: the agent coordinates shared file
updates, and plugins enforce canonical record-write guards. The host keeps plugin
workspace invocations excluded until all native turns finish.
The agent decides when to send through the message CLI.
A recurring schedule has at most one pending or active occurrence. Shared
provider resources still need writer coordination. This is admission to the existing native executor, not a second queue or
workflow controller.

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
Foreground chat and scheduled tasks do not initialize or migrate one shared
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
Stopping the relay also stops its workers, except on host-capable agents: a
graceful relay stop hands running host-transport runs to the next relay, which
adopts them without relaunching (see [Docker runtime](docker-runtime.md)). A
request the host had not yet claimed when the relay stopped is failed by the host
without starting. Run and delivery records are otherwise relay memory: a process
restart drops in-flight runs and queued deliveries by design, so the next
eligible occurrence dispatches normally and nothing is replayed from disk. Status labels failed runs as history and shows recent reasons; new failures retain their exit code or interruption cause. Typing indicators stop after 30 seconds even when work continues. A failed run that cannot prove whether an external side effect happened stays visible until the agent inspects the evidence and explicitly edits the schedule. Inspect the task's files, native session and delivery
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

`failures [--all] [--limit N]` returns failedAt, reason, exit code, native session, captured error and runtime versions. Capture keeps at most 4 KiB of redacted stderr, including a failed native Codex turn's error message when supplied. A failure without error details remains explicitly unknown; historical failures are not backfilled. `run RUN_ID` reads an owned run. `review RUN_ID --failed-at ISO --status resolved|attention --diagnosis TEXT --recovery TEXT --outcome TEXT` records the investigation without rewriting execution history. A stale timestamp is rejected; a later failure needs a new review. Restricted reply, external and isolated-task callers cannot review failures. An attention review is handed off, not repeatedly relaunched; another new failure wakes the next review.

For a shareable operational projection, use `evidence [RUN_ID] --offset 0 --limit 100`.
This reads the live relay through its existing authenticated socket, under the
bound operator or an active unrestricted Telegram owner run. Application/channel,
external and isolated-task callers cannot use it. It exposes only current-owner
Telegram foreground/scheduled runs, stable IDs, clocks/status/presets, failure
metadata without prose, and retained run-associated outbox metadata. No native
session, prompt, reasoning, tool arguments/results, message text or channel identity
is returned. Failure text is represented by its SHA-256, not copied or diagnosed.

The response carries exact `readStartedAt`/`observedAt`, `snapshotSha256`, and
coverage total/offset/limit/returned/nextOffset. Follow `nextOffset` with the same
`--expected SNAPSHOT_SHA256`; changed retained evidence fails closed and requires
a fresh traversal. Each page recomputes the projection; no snapshot store or
background capture is added. History resets on relay restart and is bounded to
2000 terminal runs and 2000 terminal outbox items; full historical coverage cannot
be inferred. Unassociated deliveries and excluded scopes remain unknown.

Delivery records identify queued/sent/failed/unknown state and whether a retained
Telegram receipt contains a valid clock and returned message IDs (only their count
is exported). The submitted UTF-8 text/voice-text hash can be compared to an exact
canonical source. It does not prove rendered or current recipient-side content;
attachments are not exported. Empty receipt lists never prove that no delivery
occurred. The relay does not retain native tool/delegation events, so that coverage
is explicitly unavailable. This command does not mark failures reviewed, send
messages, read private sessions, trigger work or certify owning results.

The prompt controls diagnosis, authorized recovery and quiet notification behavior. Inspect prior effects and receipts before retrying anything. A failed review run itself remains visible as a new failure for the next occurrence.

The Telegram Scheduled tasks menu lists paused schedules alongside enabled schedules
that still have a pending occurrence or a queued/running occurrence. Paused tasks
are labeled Paused and have no next run; an existing queued/running occurrence
keeps its execution state visible. Finished enabled one-time tasks and enabled
revisions stopped for review are hidden. Each entry shows the
frequency with the cron timezone, the saved primary and fallback setups in order
(CLI, login profile, model and effort), next occurrence in UTC (or queued/running state),
and the first sentence of its saved invocation
prompt, limited to 140 characters. This is a read-only view; history and full
prompts remain available through the scheduling CLI. `/tasks N` shows the same
frequency and execution path with the saved instructions. Common minute/hourly,
daily and weekday rules have plain-language labels; other calendar rules show
the exact cron expression and timezone. Interval rules show their fixed period,
and one-time tasks show `Once`. This describes the schedule, not a guarantee of
work when admission/preflight conditions are unmet.
