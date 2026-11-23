# Plugin-backed scheduled preflight

Empty or unchanged provider work can skip a scheduled session. Eligible work uses the schedule's saved execution settings. Core owns admission; installed read-only plugin commands own provider eligibility. Preflight requires the bound plugin broker used by isolated deployments; unavailable broker or provider reads fail closed.

A schedule's `preflight` is `{ "on": "eligible" | "changed", "checks": [{ "alias": "registered-read-only-command", "args": ["literal", "arguments"] }] }`.
The plugin emits `{ "schemaVersion": 1, "eligible": boolean, "fingerprint": "sha256 hex", "observedAt": "ISO timestamp", "count": integer }`.
Core sets `EZ_PREFLIGHT_SINCE` (an ISO instant) in each check's environment: the start of the scheduler tick, or of the manual trigger, that the check serves. A plugin may answer several checks from one provider read made at or after that instant and must never use an older one; a plugin that ignores it reads once per check, as before. Core stays unaware of what is read.
Any check eligible admits the owning saved task; changed mode additionally requires a new combined fingerprint. No domain rules or DAG execution live in core. Empty/unchanged checks advance the ordinary schedule cursor without a run/session. Errors retain a sanitized preflight receipt and skip the occurrence; no empty-success fallback.

Use `--preflight-file FILE` when creating/editing a native task. Editing preserves its condition unless explicitly replaced; `--clear-preflight` removes it. Preflight receipts remain on the native schedule cursor outside the agent workspace. Manual triggers run the same gate; an ineligible manual request reports unmet preflight and creates no run.
