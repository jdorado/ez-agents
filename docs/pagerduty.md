# PagerDuty critical-outage paging

PagerDuty alerting is an optional core capability. It observes Stocks from the
Ez runtime and sends Events API v2 trigger and resolve events; Stocks never
receives the PagerDuty routing key.

Create an Events API v2 integration in the PagerDuty service that should page
you. Put only its routing key in the deployment's private `relay.env` file:

```dotenv
PAGERDUTY_ROUTING_KEY=<Events API v2 routing key>
```

Then add the tunnel-visible endpoint and monitor settings to the deployment's
non-secret `docker.env` file:

```dotenv
EZ_PAGERDUTY_STOCKS_HEALTH_URL=http://10.97.0.1:3006/health/critical
EZ_PAGERDUTY_POLL_SECONDS=30
EZ_PAGERDUTY_FAILURE_THRESHOLD=3
```

The core checks the endpoint every 30 seconds by default. Three consecutive
unhealthy checks trigger one incident with the stable deduplication key
`ez:stocks:critical-health`; recovery resolves that same incident. A failed
PagerDuty submission remains eligible for a later trigger. On startup, the first
healthy check resolves any incident left by the previous process, including an
uncertain trigger delivery. Failed resolves retry without treating healthy
Stocks as an outage. No key or health
response is written to agent workspaces, executor environments, or logs.

`/health/critical` is intentionally narrower than Stocks `/health`: it pages
only when the Stocks source worker is unavailable. Provider freshness and other
research-quality degradation remain visible in normal Stocks health/status but
do not page. The endpoint returns only a status and component summary and must
be reachable from the core runtime over the private tunnel. Run core outside the
Stocks VM if you want a VM outage to be page-worthy.

After deployment, use PagerDuty's test/escalation tooling or temporarily point
the monitor at an intentionally unreachable private test target, then restore
the real target and confirm the PagerDuty incident resolves. This is an explicit
operational test and may notify your escalation policy.
