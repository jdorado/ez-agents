# Workforce Watch

Workforce Watch is a separate, small Docker service for missed agent check-ins
and explicit terminal failures. It is not an agent, scheduler, log store or
remote-execution channel. It retains only the five latest compact activity
records supplied by each enrolled worker.

Run it in a failure domain separate from the workers it watches. In particular,
it must not rely on the Stocks VM to report a Stocks VM outage, and a separate
host is required to detect a Mac-wide outage.

## Start the monitor

Set private monitor-only values, never agent-workspace or source-control values:

```text
EZ_WATCH_ENROLL_TOKEN=<private fleet enrollment secret>
TELEGRAM_BOT_TOKEN=<alert bot token>
EZ_WATCH_TELEGRAM_CHAT_ID=<owner chat id>
```

The owner may explicitly authorize the CTO bot token temporarily. A dedicated
alert bot remains preferable because it preserves an independent delivery identity.

```sh
docker compose -f compose.workforce-watch.yaml up -d --build
curl http://127.0.0.1:9919/healthz
```

The default bind is loopback. Put private TLS networking or a private reverse
proxy in front of it before remote workers use it; do not expose enrollment or
check-in traffic publicly.

## Enroll and check in

The worker selects its monitor through its configured URL. It submits the fleet
enrollment secret once; the response contains the worker-specific secret. Store
that response only in the worker's private service environment and discard it
from shell history and logs.

```sh
curl --fail-with-body -X POST "$EZ_WATCH_URL/v1/enroll" \
  -H "Authorization: Bearer $EZ_WATCH_ENROLL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"workerId":"stocks-production","checkInSeconds":300,"graceSeconds":180,"severity":"critical"}'
```

The supervisor, not the LLM, posts check-ins using the returned worker secret:

```sh
curl --fail-with-body -X POST "$EZ_WATCH_URL/v1/workers/stocks-production/check-in" \
  -H "Authorization: Bearer $EZ_WATCH_WORKER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"status":"ok","activity":"strategy receipt delivered","runId":"daily-strategy-2026-09-11"}'
```

An unrecoverable condition sends `{"status":"failed","terminal":true,...}`.
Optional `activity`, `error`, `runId`, and `logsHint` fields are size-limited and
appear in an alert. They must be public-safe operational context, never stdout,
prompts, holdings, credentials, or provider payloads.

## Inspect

The enrollment token reads redacted state; worker secrets never appear:

```sh
curl --fail-with-body "$EZ_WATCH_URL/v1/workers" \
  -H "Authorization: Bearer $EZ_WATCH_ENROLL_TOKEN"
```

The service triggers once for a missed deadline or terminal failure. It sends a
recovery notice only after two clean check-ins by default to prevent flapping.
