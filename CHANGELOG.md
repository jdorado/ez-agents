# Changelog

## Unreleased

- Preflight the candidate's exact pnpm version in the supervisor environment;
  reuse installed Corepack when the pnpm launcher is unavailable or incompatible.
- Report actionable service-PATH repair guidance before changing the live runtime.
- Telegram `/status` includes the running relay/host versions and installed plugin
  versions, shared through the existing host heartbeat without private registry access.

- `ez status` and `ez updates status` show installed/running relay versions, host
  transport version, plugin versions and runtime states, plus upgrade jobs.
- Missing, stale or unverifiable runtime evidence reports an unknown running
  version instead of presenting the installed candidate as live.

## 0.1.0-beta.3 — candidate, not published

- Agent-owned main/plugin upgrades from exact npm versions or local tarballs.
- Stable-default per-target policy, serialized maintenance wakeups, and a host
  supervisor that survives replacement of the requesting runtime.
- Private backups, matching schema/deployment gates and failed-health code rollback.
- Automated fixtures cover recovery; VM and live-provider acceptance are pending.

## 0.1.0-beta.2 — npm distribution

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
