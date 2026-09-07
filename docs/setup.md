# Agent-led setup

The user starts in their existing CLI and says “install Ezenciel”, then “create
an agent as my family shopper”. The installing agent does the technical work.
Keep that host CLI and login for every agent; do not request another CLI login.

## Install the supplied release artifact

Use `npm pack @jc_stack/ez-agents@0.1.0-beta.2` or the exact GitHub release
tarball. Verify its SHA-256 against the release receipt when using GitHub.
Do not guess an npm name or substitute an unscoped package.
Choose a permanent package directory and a separate private deployment directory.

```sh
mkdir -p /absolute/ez-package
# Inspect before extracting; the archive should contain only package/ entries.
tar -tzf /absolute/jc_stack-ez-agents-0.1.0-beta.2.tgz
tar -xzf /absolute/jc_stack-ez-agents-0.1.0-beta.2.tgz -C /absolute/ez-package
cd /absolute/ez-package/package
cp docker/pnpm-lock.yaml pnpm-lock.yaml
pnpm install --frozen-lockfile
export PATH="$PWD/bin:$PATH"
export EZ_AGENTS_HOME=/absolute/private/agents
docker build --target runtime -t ezenciel-agents:local .
```

Node 22+ and pnpm 10.30.3 are needed by the host transport. The tarball carries
its lockfile under docker/ because npm excludes the root pnpm lockfile. Do not
move this package directory after binding a service to its absolute paths.
For a source checkout the root lockfile is already present. Do not run a second
copy of an existing bot token. Continue with the per-agent configuration below.

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
For the first WhatsApp plugin, obtain the reviewed release source separately and
provide a catalog as described in [plugins](plugins.md). Then run:

```sh
node /absolute/ezenciel_agents/bin/ezenciel-agents-tools.mjs init \
  --home "$EZ_DEPLOYMENT_DIR/tools" \
  --workspace "$EZ_DEPLOYMENT_DIR/mind" \
  --host-config "$EZ_DEPLOYMENT_DIR/host-executor.json"
```

This binds a private `ez`, preserves native command access, pins the catalog and
loads the default packages for every new agent. For a different layout or package
selection, supply `--catalog /absolute/private/reviewed-catalog.json`; its source
paths resolve relative to that file. An explicit `{}` selects no default packages.
Initialization
adds discovery instructions to the mind's TOOLS.md. Verify `tools/bin/ez plugins
available` before the first agent turn. Also execute the agent-bound
`ezenciel-agents-message --help` through the selected CLI sandbox and verify
its actual tool output, so absent launchers or blocked execution are detected
before asking the owner to test Telegram. Afterwards the owner can request plugin
installation in conversation; the agent invokes install/start and follows the
plugin skill through onboarding and verified use under that same request.
   Follow the [installation completion contract](plugins.md#installation-completion-contract).
   Registry initialization itself does not connect accounts or start plugins.
Never silently reuse a global `ez` from the old sandbox runtime.

4. Follow [host startup templates](host-service.md). Register `bin/ezenciel-agents-host` with the host's native service manager,
   binding `EZ_DEPLOYMENT_DIR` and the user's existing CLI PATH/HOME. On macOS use
   a LaunchAgent; on Linux use a user service. Use the absolute Node/package
   paths. This generic transport is the only host execution bridge. Do not start
   another host relay or install another CLI. Verify its heartbeat, then run
   `bin/ezenciel-agents-docker up -d --wait`.
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
transport, bring its Compose project up, and verify restart persistence. Plugins are installed
when the owner requests their capability; account onboarding and provider
confirmation follow the requested use. Never use a missing plugin as a reason
to defer the main relay.

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

The beta.3 development candidate adds owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Local VM QA remains pending; do not claim this candidate is published.
