# Use Ez from your existing executor

The plugin manager and its Docker plugins work independently of the Telegram
relay. Use the same absolute launcher from any local executor to share a chosen
workspace's tools and accounts. The executor owns reasoning and conversation;
Ez owns the plugin registry and command transport. No provider-specific adapter,
new model login or GUI plugin installation is involved.

## Setup

Install the main package and its dependencies in a permanent location using the
artifact steps in [setup](setup.md). Node 22+ is needed for the manager; Docker
and Compose are needed for executable plugins. Do not build/start the relay,
create a bot, pair an owner or configure a host executor for CLI-only use.
Create a private tools directory and select the existing company/project workspace:

```sh
node /absolute/package/bin/ezenciel-agents-tools.mjs init --standalone \
  --home /absolute/private/company-tools --workspace /absolute/company-workspace
/absolute/private/company-tools/bin/ez --help
/absolute/private/company-tools/bin/ez status
/absolute/private/company-tools/bin/ez plugins list
```

Init starts nothing, uses an empty catalog by default, preserves existing
TOOLS.md notes and appends the registry's discovery instructions. A registry
cannot be replaced by rerunning init. Keep the package at its original path:
the launcher imports it. Status reports `main: null` without a relay binding;
automated software upgrades currently require a relay deployment.

Have each executor read the workspace's TOOLS.md and the installed plugin skills.
Add that instruction to its existing project instructions without replacing them.
Use the absolute launcher, or prepend its bin directory to that session's PATH.
Never overwrite another global `ez`; it may belong to a different installation.
A company registry remains explicit even when invoked from a different directory.
Other projects/accounts should use separate registries and private plugin state.

## Install and verify a capability

The current conversation owns authorized plugin onboarding. Follow the
[plugin contract](plugins.md#installation-completion-contract), using the bound
launcher for `plugins inspect <id> --source /absolute/package`, then
`plugins install <id> --source /absolute/package --revision <inspected-hash>`.
Read the skill, start the plugin, complete its provider authentication and verify
the intended account with a supported operation. Deliver any necessary consent
link or QR in the current client. No Telegram handoff is required.

Run `tools list`, the registered alias's help and a harmless account operation
from each actual executor. Host-shell access alone does not prove a sandboxed
session can access Docker or the registry. Client permissions still apply.
Native client plugins/connectors are not converted into Ez plugins automatically.

## Combine with an autonomous agent

A relay can coexist with CLI-only registries on the same machine. It retains its
own pairing, single-writer queue, mind and plugin registry. Calling its existing
bound launcher explicitly reuses that registry and its accounts; never initialize
over it or silently select it from another workspace. Coordinate writes with its
active jobs. Separate registries do not automatically share credentials or data.

Continuous monitoring requires a configured event consumer/relay and the plugin's
supported watcher. CLI-only installation does not create background agent turns.
