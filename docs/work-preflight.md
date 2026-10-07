# Plugin-backed scheduled preflight

Objective: empty or unchanged provider work does not start an LLM session; eligible work uses the schedule's saved execution settings.

Constraints: one native scheduler; installed plugin calls only; provider/domain checks stay outside core; fail closed on incomplete/invalid reads; literal owner-configured arguments and no provider text in prompts.

Owner: native scheduler admission and broker authorization in core; read-only eligibility commands in provider/product plugins. Reuse the native plugin broker rather than another poller or queue.

Proof: packed container smoke shows empty skip, eligible dispatch, unchanged skip, unavailable/invalid provider block, saved model preservation and single active occurrence. Stop only on missing authority, never a discoverable setup issue.

A schedule's `preflight` is `{ "on": "eligible" | "changed", "checks": [{ "alias": "registered-read-only-command", "args": ["literal", "arguments"] }] }`.
The plugin emits `{ "schemaVersion": 1, "eligible": boolean, "fingerprint": "sha256 hex", "observedAt": "ISO timestamp", "count": integer }`.
Any check eligible admits the owning saved task; changed mode additionally requires a new combined fingerprint. No domain rules or DAG execution live in core. Empty/unchanged checks advance the ordinary schedule cursor without a run/session. Errors retain a sanitized preflight receipt and skip the occurrence; no empty-success fallback.

Use `--preflight-file FILE` when creating/editing a native task. Editing preserves its condition unless explicitly replaced; `--clear-preflight` removes it. Preflight receipts remain on the native schedule cursor outside the agent workspace. Manual triggers run the same gate; an ineligible manual request reports unmet preflight and creates no run.
