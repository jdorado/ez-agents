# Agent-led setup

## A group as owner

An installer can explicitly approve one Telegram group as the agent's owner.
Every human member in that group then has owner access, including settings,
approvals and scheduling. The conversation and replies are shared in that group.
New members inherit this access. Bots and anonymous sender-chat posts are ignored.

Add the bot to the intended group and send it a message addressed to its username.
`ezenciel-agents-owner status` shows the pending group title and negative chat ID;
verify the exact group with the installer, then run
`ezenciel-agents-owner approve-group <negative-chat-id>`. Pairing never happens
automatically. The existing `approve <user-id>` command approves DMs only.
An existing owner must be explicitly revoked before replacement; use a fresh
deployment when its existing workspace contains information unsuitable for the group.

Make the bot a group admin so Telegram delivers ordinary member messages and
allows membership verification for approval and control buttons. Group ownership only authorizes
the exact approved chat, not other groups or members' private DMs. Telegram group
migration to a new chat ID requires a new explicit binding. Verify a real group
reply before considering setup complete. All other groups retain their existing
restricted conversation-grant behavior.

Ez supports two independent, composable uses: an autonomous Telegram agent and
workspace-scoped plugins called by your existing local CLI/GUI executor.
For CLI-only requests, follow [standalone setup](standalone-cli.md): no Telegram
pairing, relay or host executor is required. The main-first Telegram onboarding
rules below apply only when installing the autonomous relay. When both are
requested, keep each workspace's authority and registry explicit.

The user starts in their existing CLI and says “install Ezenciel”, then “create
an agent as my family shopper”. The installing agent does the technical work.
Keep that host CLI and login for every agent; do not request another CLI login.

## Main first, then plugins through Telegram

Complete the main installation, verified owner pairing and an actual agent reply
in Telegram before installing or onboarding any plugin. A supplied WhatsApp
tarball is optional follow-up input, not a prerequisite. Do not open its setup
flow, build it, create its catalog entry or ask for a QR scan during main setup.
Initialize the main registry with the packaged empty catalog only.

After the main agent replies successfully, ask the owner to continue in that
Telegram conversation: “Install WhatsApp from <exact supplied tarball path>.”
The installed agent owns artifact inspection, extraction into its writable tools
directory, catalog registration, install/start and QR delivery in Telegram. The
original installing CLI must not take over plugin onboarding. If Telegram cannot
complete a required tool action, diagnose that boundary and report the failure;
do not finish it externally and call the Telegram workflow successful. An explicit
owner request for standalone plugin development is a separate workflow.

## Defaults and host prerequisites

Use the existing owner's host account. Unless a layout was supplied, use
`${XDG_DATA_HOME:-$HOME/.local/share}/ez/packages/<version>/` for extracted main
packages and `${XDG_DATA_HOME:-$HOME/.local/share}/ez/agents/` for private deployments.
Never overwrite an existing package/deployment or extract over its state. Infer
the agent name and purpose from the owner's request; ask only when missing.

Before running Node commands, check `command -v node` and `node --version`.
If Node 22+ or this package's pinned pnpm is missing, provision it using the
host OS's supported installation method and official distribution instructions,
then verify the version and service PATH yourself. This is installer work, like
Docker setup below; do not ask the owner to execute a dependency checklist.
Only an actual OS consent, admin credential or account-access boundary needs the
owner. Do not bundle runtimes or change the host's unrelated default toolchain.

Once Node is available, the dependency-free diagnostic works before pnpm install:

```sh
node /absolute/package/bin/ezenciel-agents-install preflight --executor /absolute/path/to/codex
```

It reports Node/pnpm, Docker daemon access, Compose, host disk space and the selected
executor path/version. Disk availability is advisory: inspect Docker's own storage
too. For an executor path, inspect its identity/version and use the corresponding
supported key (for example, a verified `/path/to/codex` becomes `codex`). Ensure its
directory is in the service PATH; a similarly named file is not identity proof.
The preflight does not prove CLI authentication or sandbox execution; perform the
harmless tool-call check below. Retry preflight after fixing failed checks.

## Install the supplied release artifact

Use `npm pack @jc_stack/ez-agents@0.1.0-beta.12` or the exact GitHub release
tarball. Verify its SHA-256 against the release receipt when using GitHub.
Do not guess an npm name or substitute an unscoped package.
Choose a permanent package directory and a separate private deployment directory.

```sh
mkdir -p /absolute/ez-package
# Inspect before extracting; the archive should contain only package/ entries.
tar -tzf /absolute/jc_stack-ez-agents-0.1.0-beta.12.tgz
tar -xzf /absolute/jc_stack-ez-agents-0.1.0-beta.12.tgz -C /absolute/ez-package
cd /absolute/ez-package/package
cp docker/pnpm-lock.yaml pnpm-lock.yaml
pnpm install --frozen-lockfile
export PATH="$PWD/bin:$PATH"
export EZ_AGENTS_HOME=/absolute/private/agents
node bin/ezenciel-agents-install build
# Set EZ_RELAY_IMAGE to the exact image returned by build for create/start.
export EZ_RELAY_IMAGE='<returned-image>'
```

Node 22+ and pnpm 10.30.3 are needed by the host transport. The tarball carries
its lockfile under docker/ because npm excludes the root pnpm lockfile. Do not
move this package directory after binding a service to its absolute paths.
For a source checkout the root lockfile is already present. Do not run a second
copy of an existing bot token. Continue with the per-agent configuration below.

Verify the tarball against its adjacent `.sha256` or the kit's `SHA256SUMS` before
extracting. The build tool uses a content-specific image and exclusive build lock,
with details in the returned private log. A repeated request reports an existing
build or reuses its verified completed image. If a build was interrupted, inspect
the log and owning process before recovering its lock; never start duplicates.
The creator persists the selected EZ_RELAY_IMAGE in the deployment's `docker.env`,
so later service starts use the same build without depending on shell environment.

## Create, start and verify

1. Make the host ready yourself. Check Docker Engine, Docker Compose, host
   Node 22+, this package and the current CLI. If Docker or Compose is absent,
   not running, or unusable by the current user, install the official supported
   Docker distribution for this operating system, start it, and complete its
   normal user-access setup. Verify with `docker version`, `docker compose
   version`, and a harmless disposable container before continuing. Do not
   hand Docker installation, daemon startup, image building, or Compose
   commands to the owner. An administrator password, operating-system consent,
   or Docker Desktop sign-in that the installer cannot approve is the only
   reason to ask the owner for one concrete action; resume immediately after.
   Build the relay image once. Record the installing CLI immediately with
   `ezenciel-agents-create --register-cli <current-cli>`. This is installer metadata,
   not a question for the user. Do not assume an unpublished npm package exists.
   Before requesting a bot token, verify a real harmless command through the
   selected CLI's execution sandbox under the same host user and service
   environment. A CLI version check, successful model response, or zero exit
   code does not prove shell tools work. Inspect the tool result itself.
   On Ubuntu, `bwrap: setting up uid map: Permission denied` can indicate
   AppArmor's unprivileged-user-namespace restriction. Confirm this with the
   kernel audit log before changing anything. Explain and obtain authorization
   for any required host security-policy change; prefer an executable-specific
   policy reviewed for the installed CLI path. Do not globally disable AppArmor
   or user-namespace restrictions, or disable the CLI sandbox as a fallback.
   Repeat the actual sandbox command after remediation. If blocked, report
   the precise prerequisite and keep installation pending.
2. Obtain a separate BotFather token for the new agent. Pass it through stdin
   to the creator; keep it out of argv, logs, images and Markdown.
   `ezenciel-agents-create` reads the token from stdin by default and does not
   accept `--token-stdin`. That flag belongs to `ezenciel-agents-setup configure`.
3. Create its deployment with the host installation's selected CLI:

```sh
export EZ_AGENTS_HOME=/absolute/private/agents
bin/ezenciel-agents-create --name family-shopper --purpose 'Help my family plan shopping.' < /private/bot-token
export EZ_DEPLOYMENT_DIR="$EZ_AGENTS_HOME/family-shopper"
```

Agent creation defaults to the CLI recorded when the initial package was
installed. It needs no `--cli` argument. A later shell or different available CLI
does not change that saved default. No installed-binary ranking or Grok fallback
is used.
The creator writes `host-executor.json`, private secrets, mind/control paths,
purpose and unique plugin volume names. Duplicate names fail without overwriting.
`ezenciel-agents-create --list` lists deployments without secrets.

Before starting that host transport, initialize the main package’s built-in plugin manager. It runs on the host
for Docker access and adds no separate package or provider library. The packaged catalog is empty so the relay installs independently.
Use its empty default catalog. Plugin preparation follows the verified Telegram
handoff, not this step. Run:

```sh
node /absolute/ezenciel_agents/bin/ezenciel-agents-tools.mjs init \
  --home "$EZ_DEPLOYMENT_DIR/tools" \
  --workspace "$EZ_DEPLOYMENT_DIR/mind" \
  --host-config "$EZ_DEPLOYMENT_DIR/host-executor.json"
```

This binds a private `ez` and preserves native command access. The default catalog
is empty. Do not supply a plugin catalog during first-time main onboarding.
Initialization
adds discovery instructions to the mind's TOOLS.md. Verify `tools/bin/ez plugins
available` before the first agent turn. Also execute the agent-bound
`ezenciel-agents-message --help` through the selected CLI sandbox and verify
its actual tool output, so absent launchers or blocked execution are detected
before asking the owner to test Telegram. Only after a real owner exchange has
succeeded, the owner requests plugin installation in that Telegram conversation;
the installed agent registers the supplied source, invokes install/start and follows
the plugin skill through onboarding and verified use under that same request.
   Follow the [installation completion contract](plugins.md#installation-completion-contract).
   Registry initialization itself does not connect accounts or start plugins.
Never silently reuse a global `ez` from the old sandbox runtime.

4. Follow [host startup templates](host-service.md). Register `bin/ezenciel-agents-host` with the host's native service manager,
   binding `EZ_DEPLOYMENT_DIR` and the user's existing CLI PATH/HOME. On macOS use
   a LaunchAgent; on Linux use a user service. Use the absolute Node/package
   paths. This generic transport is the only host execution bridge. Do not start
   another host relay or install another CLI. Verify its heartbeat, then run
   `bin/ezenciel-agents-docker up -d --wait`.

   `ezenciel-agents-setup service` is Docker-only startup: run it from the
   deployment directory containing `docker.env`. It starts the relay and does
   not install or start the host-executor user service. Complete the host
   registration above separately.

5. Ask the owner to message the exact bot. Verify the pending numeric identity,
   approve it, and verify a real CLI-produced Telegram reply. Check restart
   persistence and two agents running concurrently with separate state.
   A healthy container and completed CLI run are insufficient: require a
   Telegram receipt from the CLI-produced reply. If absent, inspect the native
   CLI transcript and outbox before claiming success or asking the owner to
   repeat a message. Use the supplied outbound smoke test with the poller
   stopped to verify repairs, then restore the poller; never replay uncertain
   user actions merely to test delivery.

The main runtime is fully installer-owned: build it, register its host
transport, bring its Compose project up, and verify restart persistence. Plugins
are installed by the working Telegram agent when the owner requests their
capability there; account onboarding and provider confirmation follow that request.
Never use a missing plugin as a reason
to defer the main relay.

Check progress with `ezenciel-agents-install status --deployment /absolute/deployment`.
It distinguishes missing configuration, runtime offline, awaiting owner, awaiting
a verified Telegram reply and readiness for a Telegram plugin request. It inspects
current heartbeats and owner-bound completed-run delivery receipts without sending
messages or exposing tokens. Receipt evidence is historical: separately verify
the current conversation and restart persistence before declaring setup complete.

Purpose seeds SOUL.md once; future customization survives restart. Conversations,
pairing, files and plugin accounts are separate. The existing host CLI login is
shared, so this is not a security sandbox against other agents under that user.
Plugins run in their own containers and own their authentication. Install and
register them only for the requested agent. Never clone another agent's plugin
credentials. See [runtime, migration and QA](docker-runtime.md).

The installing CLI is an initial default, not a permanent restriction. An explicit
owner selection may use any supported CLI/model installed on the host. Native
`ezenciel-agents-ai list` and `select` expose this choice. A cross-CLI switch
starts a fresh native conversation and preserves the mind and installation
default. Existing queued jobs retain their captured execution choice.

## Troubleshooting

| Symptom | Inspect and recover |
|---|---|
| Docker unavailable | Check engine and Compose, start the supported installation; complete any required OS consent. |
| Bot stays silent | Check pending owner identity, relay health, host heartbeat and outbox; approve only the verified owner. |
| CLI exits without reply | Inspect the actual tool result and delivery receipt; stdout is not Telegram output. |
| Exit 73 | An existing writer holds this deployment; stop the exact duplicate, never delete the kernel lock. |
| Plugin absent | Check the bound catalog and install/start the reviewed package explicitly; no plugin ships by default. |
| Plugin revision mismatch | Reinspect stable source, review the changed hash and explicitly update its catalog pin. |
| Interrupted CLI cannot resume | Use the explicit new-conversation command after inspecting the failure; no automatic fallback. |

Use `ezenciel-agents-docker logs --tail 100 relay` with EZ_DEPLOYMENT_DIR bound.
Sanitize logs before sharing. Back up mind/control and private profiles before
upgrades. Stop the exact Compose project and host service to remove execution;
retain state unless deletion was requested. Revoke a Telegram bot token through
BotFather and a WhatsApp device on the phone separately from removing software.

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.
