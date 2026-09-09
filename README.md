# ezenciel-agents

Registered external events are currently recorded but blocked from executing in
the trusted-owner runtime. Plugin commands can declare exposure metadata; see
[plugin declarations](docs/plugins.md#exposure-declarations) and
[authority boundaries](docs/architecture/authority-boundaries.md).

Telegram `/status` shows the running relay and host
versions plus installed plugin versions. The agent's `ez status` adds verified
plugin runtime states and upgrade job receipts. See [status and upgrades](docs/upgrades.md).

**Beta 0.1.0-beta.12 — for testing on a trusted machine.** Offline and Docker
fixtures are verified. Live account onboarding and reboot acceptance for this
release are deferred; this is not a production-readiness claim.

The npm package is `@jc_stack/ez-agents` (channel `beta`). Download a pinned
release with `npm pack @jc_stack/ez-agents@0.1.0-beta.12`, or get the tarball and SHA256SUMS from
[GitHub prereleases](https://github.com/jdorado/ez-agents/releases/tag/v0.1.0-beta.12).
GitHub remains under `jdorado`; npm uses `jc_stack`. Do not install the unrelated
unscoped `ez-whatsapp` package.


Installed runtime operation uses Docker Compose. Read
[Docker setup, state and QA](docs/docker-runtime.md). Docker owns relay/plugin services; the existing host CLI and login are shared
through one generic transport, with separate agent workspaces and sessions.

A minimal Telegram-to-AI-CLI relay. One owner, one persistent Markdown mind.

## You are the installing agent

If the user says **install** or **set up** this repository/package, complete
[docs/setup.md](docs/setup.md) yourself. The instructions and commands in this
repository are addressed to you, the LLM with computer access, not the human.

**Your finish line is a working Telegram reply and automatic startup.** Adding
npm dependencies, printing `--help`, or creating files is not completion.
Install the main runtime alone first, with an empty plugin catalog. Even when
WhatsApp is supplied or requested alongside it, defer plugin setup and QR scanning
until owner pairing and a real agent reply are verified. Then the owner requests
the plugin in Telegram and the installed agent handles onboarding there. The
initial host CLI must not install the plugin on that agent's behalf.
Do not hand the human terminal commands, ask them to start the relay, leave a
terminal open, read logs, find their numeric Telegram ID, or approve pairing
from another terminal. You own those steps and their verification.

Only involve the human for missing account access, a bot token you cannot
obtain through authorized tools, confirmation of which Telegram account is
theirs, or an OS-level authorization prompt you cannot approve yourself. Give
one concrete action at a time, with the exact link. Resume setup when they
answer. Explain actual blockers in plain language.

### Docker is installer work

Docker and Compose are required, but they are **not a prerequisite the human
must install**. First inspect the host. If Docker is absent, stopped, or lacks
Compose, install the official supported Docker distribution for that operating
system yourself, start it, and arrange the normal user access it requires.
Then verify the engine and Compose with a harmless real container before
building this package. Do not respond with “install Docker and retry,” a list
of commands for the human, or a request to open a terminal.

An administrator password, native system approval, or Docker Desktop sign-in
dialog is a human-only boundary. When one appears, explain the single action
needed and continue immediately after it. Everything else—package install,
image build, host transport, Compose startup, pairing, and a real Telegram
reply—is the installing LLM's job.

### Recognize this artifact immediately

This is a **Node.js npm package**, not a Python package or a Codex skill.
For a supplied tarball, read `package/README.md` and `package/docs/setup.md`
from that archive. Install that artifact; do not search npm, PyPI, or skill
catalogs for its name. Build/run its Docker image; Docker and Compose are
required on the host and the installing LLM makes them ready if needed. The
image supplies relay dependencies; the existing host CLI supplies execution.

Use the exact scoped npm name and version above, or the supplied tarball/path.
A bare product name is not a package identity. Inspect the artifact before setup;
do not substitute a similarly named package.

### Installer tools

Run these yourself from the installation directory. Read the setup guide for
credentials, startup, and verified pairing; never present this as human homework.

| Tool | Purpose |
|---|---|
| `ezenciel-agents-install preflight --executor <path-or-name>` | Check prerequisites, disk and executor identity hints before setup |
| `ezenciel-agents-install build` | Build once per artifact, with a private log and duplicate-build detection |
| `ezenciel-agents-install status --deployment <path>` | Distinguish runtime/configuration, pairing and Telegram reply evidence |
| `ezenciel-agents-create --register-cli <current-cli>` | Record the CLI that installs the initial package |
| `ezenciel-agents-create --name <name> --purpose <purpose>` | Create an agent inheriting the installation CLI; token via stdin |
| `ezenciel-agents-host` | Invoke the existing shared host CLI for this deployment |
| `ezenciel-agents-setup configure <executor>` | Private configuration and missing starter files; preserves personal files |
| `ezenciel-agents-setup configure <executor> --token-stdin` | Same, with the BotFather token supplied privately through stdin |
| `ezenciel-agents-setup service` | Start only the Docker relay bound by `docker.env` in the current directory; register the [host service](docs/host-service.md) separately |
| `ezenciel-agents-owner status` | Inspect the owner and pending pairing requests |
| `ezenciel-agents-owner approve <telegram-user-id>` | Approve the verified owner; never an arbitrary first sender |
| `ezenciel-agents-setup status` | Inspect installed executor choices |
| `ezenciel-agents-setup init` | Seed only missing workspace guidance |

Run runtime tools through `ezenciel-agents-docker run --rm relay <command>`
as shown in the Docker guide. Keep the Docker engine available; Compose owns
restart and shutdown. The installing agent registers the small host CLI transport with the native service manager.

## Runtime and development reference

The selected host CLI runs in this agent's persistent workspace and owns its
Markdown/work files. New conversations and AI changes preserve those files.
`AGENTS.md`, `SOUL.md`, `USER.md`, and `TOOLS.md` are seeded; `MEMORY.md` is
optional. Received files go in `inbox/`, tasks and deliverables in `work/`.
Credentials and control state stay outside the mind. File separation is not
OS isolation against a process running as the same user.

Telegram intake is owner-gated. The executor sends replies with the messaging
CLI; stdout is not a reply. A process exit code is not delivery proof.
Voice/media needs its additional providers and tools; defer optional setup
until the owner asks. Do not advertise unverified integrations.

For code development only: `pnpm install`, then `pnpm verify` for offline tests
and TypeScript. `pnpm smoke` uses real providers and a paired owner; it verifies
outbound delivery, not the full incoming Telegram path. Never publish publicly
without authorization. Local registry rehearsal uses `pnpm publish:local`.

- [Setup and troubleshooting](docs/setup.md)
- [Architecture and run semantics](docs/architecture/telegram-intake.md)
- [Saved AI choices](docs/architecture/ai-selection.md)
- [Development and verification](docs/development-and-testing.md)
- [Authority boundaries](docs/architecture/authority-boundaries.md)
- [Security scope](SECURITY.md)

- [Contributing](CONTRIBUTING.md) and [releasing](docs/releasing.md)
- [First plugin and extension contract](docs/plugins.md)
- [License and dependency notices](THIRD_PARTY_NOTICES.md)

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](docs/upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.
