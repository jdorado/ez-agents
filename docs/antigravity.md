# Antigravity host execution

Host-capable installations can select Google Antigravity (`agy`, alias
`antigravity`) through the existing AI catalog and native execution transport.
Existing CLI, model, effort and schedule selections remain unchanged. Use
Antigravity CLI **1.3.4 or newer**; this version supports unlimited print-mode
completion and reasoning efforts `low`, `medium`, `high`, `xhigh`, `max`.
The current isolated runtime image does not bundle Antigravity.

Install the native CLI on the deployment's execution host from
[Google's official distribution](https://antigravity.google/cli/install.sh).
The installer supports `--dir PATH`; services need the actual executable on
PATH, rather than a shell alias. For an existing binary use `agy update`.
Verify the manifest checksum and `agy --version` before acceptance.

The owner signs in interactively under the approved execution identity on that
host. Do not copy another user's tokens or reuse a workstation login on a remote
host. Headless runs use the native client's cached authentication; they cannot
complete sign-in. Native settings/keyring access are owned by the CLI. Named Ez
login profiles and API-key forwarding are not part of this adapter.
See [Google's authentication guide](https://antigravity.google/docs/cli/install/).

Headless runs cannot answer permission prompts, so Ez passes
`--dangerously-skip-permissions`, exactly as it does for Claude Code. Without it
every command is auto-denied and the turn ends successfully with no reply. Ez
plugin authority and the host user's own filesystem and network isolation remain
the boundary; do not hand-edit the CLI's `settings.json` permission grants.

Ez sends one literal stdin message and closes input. Antigravity owns context,
loads the workspace's `AGENTS.md`, and emits its native conversation ID. Ez
captures that ID and passes `--conversation` on continuation. It never uses
`--continue` or reconstructs native history. New application scopes and native
scheduled runs start separate conversations. See
[Google's headless contract](https://antigravity.google/docs/cli/headless/).

Acceptance needs a real bound application request and a canonical plugin read,
with no domain changes. Verify the native ID, interleave another scope and
resume the first, inspect the plugin receipt, and verify cancellation. Installing
a binary, listing models, synthetic tests or a healthy relay alone do not
establish a working authenticated integration. Antigravity-specific quota
fallback classification and run telemetry are not supported; unknown failures
stop without retrying the work.
