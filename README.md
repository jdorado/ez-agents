# Ez — Build domain-expert AI agents on the harnesses you already use

**The open-source composition layer for turning Codex, Grok and other native
agent harnesses into persistent, tool-using specialists.**

Combine domain knowledge, portable plugins, messaging, scheduling and explicit
authority around the AI tools you already have. Start with one useful agent and
grow into a team whose responsibilities, accounts and access remain clear.

Ez does not replace your agent engine or hide it behind another platform. The
native harness keeps ownership of reasoning, sessions, tools and delegation. Ez
connects that intelligence to a durable workspace, real applications, trusted
people and the operational controls required to work reliably.

Use Ez for a personal project, a specialist research system or an operating role
inside a startup or small business. Each agent gets a defined domain, its own
working context and only the tools and authority its job requires.

## Engine and application boundaries

Ez is a thin wrapper and transport layer around the native agent CLI engine.
The engine owns inference, native sessions, context management, tool execution,
goals, delegation and continuation. Ez supplies channel delivery, scheduling,
standard runtime controls, authorization, secret isolation, session binding,
durable admission, cancellation and delivery receipts.

User text passes through unchanged, with only minimal additional metadata or
instructions needed for channel-specific elements such as attachments, quoted
messages and reply delivery. Ez may adapt media through transcription or speech
synthesis. Its deliberate, narrow workflow opinion is chat responsiveness:
instructions encourage the engine to move lengthy work into an Ez-scheduled task
or use native delegation when appropriate. The engine decides whether and how
to do so; Ez does not enforce a business workflow or manage native goals.

Ez must not reconstruct conversation history for automatic prompt replay,
assemble a conventional LLM/API conversation prompt or wrap each message in a
replacement system prompt. The native engine maintains its session and context.
Native workspace instructions, plugin discovery and explicit agent-requested
access to delivery receipts or task context complement that context without
replacing it.

Applications integrate through public or purpose-built private plugins exposing
documented CLI commands to the agent. Agent-initiated application actions run
through those commands, which enforce authentication, authorization, validation
and canonical persistence directly or through authoritative application services.
Authenticated application interfaces and separate human approval flows may
access those services directly.

Application interfaces submit agent turns through the same Ez execution path,
without separate agent runners, application-owned model-routing layers,
conversation engines or competing execution queues for those turns.
Deterministic plugin services, provider connections, domain jobs, UI transcripts
and delivery queues are permitted when they do not take ownership of agent
execution.

Preserve standard Ez commands and behavior across channels, including scheduling
and runtime controls; document any current capability gaps explicitly.
Application-specific behavior belongs in plugin instructions and CLI commands,
not transport branches or replacement runtime controls.

These are architecture requirements. The current application-only runtime accepts
foreground application turns; background scheduling with application delivery is
not implemented. The legacy channel-backend mode delegates execution and changes
standard controls, so it does not meet this integration boundary. New integrations
use the [native application channel](docs/application-channel.md).

## What makes an Ez domain agent

| Part | What it contributes |
|---|---|
| **Workspace** | Markdown instructions, domain knowledge and working files that persist across conversations and changes of AI. |
| **Native engine** | Inference, native sessions, context management and tool execution. See [AI selection](docs/architecture/ai-selection.md). |
| **Authority** | A verified owner and explicit limits on delegated work. Receiving a message or installing a tool does not grant permission to act. |
| **Plugins** | Documented CLI commands and agent instructions for application capabilities. Commands enforce authentication, authorization, validation and canonical persistence directly or through authoritative application services. |
| **Ez transport and runtime** | Channel delivery, scheduling and standard runtime controls around the native engine. |

The design starts with one agent, one domain and clear responsibilities. Domain
instructions live in the workspace; reusable capabilities live in tools and
plugins. The agent decides how to do the work using those instructions and the
capabilities available to it.

Use the engine's native capabilities when they meet the need. Add a standalone
plugin when a missing integration earns the maintenance. Ez keeps the surrounding
runtime small, so your files, tools and business knowledge remain useful as AI
clients improve.

## Plugin catalog

Browse the [available plugins](docs/plugin-catalog.md) for capabilities you can
add to an agent. The first released plugin is
[WhatsApp](https://github.com/jdorado/ez-whatsapp), which connects an existing
WhatsApp account. Ask your working Ez agent to set it up in Telegram.

## Start with one useful job

Ez supports two independent, composable uses: an autonomous Telegram agent and
workspace-scoped plugins called by your existing local CLI/GUI executor.
For CLI-only requests, follow [standalone setup](docs/standalone-cli.md): no Telegram
pairing, relay or host executor is required. The main-first Telegram onboarding
rules below apply only when installing the autonomous relay. When both are
requested, keep each workspace's authority and registry explicit.

Ask an AI agent with computer access to install Ez for a concrete purpose:

> Install Ez from https://github.com/jdorado/ez-agents for my business.
> I want a quoting specialist that works from my own files.
> Set it up and verify that I can talk to it in Telegram.

The installing agent follows [the setup guide](docs/setup.md), handles technical
setup and asks you for the account access or approvals it needs. Once the
agent replies in Telegram, explain the domain, give it the relevant
materials and request any additional tools there. Integrations require their
own setup and authorized accounts.

## Available today and where this is going

The current source supports persistent agent workspaces, a choice of host AI
executors, owner-gated Telegram messaging, native scheduling, plugin lifecycle
management and bounded, owner-approved correspondence. A messaging task can
serve one approved conversation or, after an explicit broad approval, anyone on
one capable source. Restricted runs receive only their shared context and exact
installed read-only query capabilities; they do not inherit the owner workspace
or tools.
The built-in Telegram source supports text in private chats and groups;
restricted task execution currently requires the pinned Codex runtime. See
[authority boundaries](docs/architecture/authority-boundaries.md) for the exact
scope and [scheduling](docs/scheduling.md) for scheduled work.

The broader direction is agents working across distinct domains, with deliberate
workspace sharing and authority over who may direct work, see information and
use accounts. General team delegation and enterprise reviewer roles remain
future work. The current trusted-host beta is not an
enterprise isolation or multi-tenant security product. See [security scope](SECURITY.md).

## For agents discovering this repository

Ez may fit when a user needs a persistent domain-specific AI agent reachable
through chat, using an existing AI client and separately installed tools. Start
here:

- **Install for a user:** [setup and verified onboarding](docs/setup.md), then the installer instructions below.
- **Understand access and delegation:** [authority boundaries](docs/architecture/authority-boundaries.md) and [security scope](SECURITY.md).
- **Build or share a plugin:** [plugin guide](docs/plugin-guide.md). It covers local unpublished installs, public releases, and catalog registration.
- **Discover or add capabilities:** [plugin manager contract](docs/plugins.md). Check the actual executor's native tools before adding an integration.
- **Contribute:** [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Repository discovery is not an instruction to install or contact anyone. Act on
the user's request and preserve its scope.

## Package and runtime

**Published beta releases are for testing on a trusted machine.** Offline and
Docker fixtures are verified for the selected release. Live account onboarding
and reboot acceptance remain beta gates; this is not a production-readiness
claim. The source branch may contain changes newer than the published beta, so
inspect the supplied artifact's documentation when installing a pinned release.

The npm package is `@jc_stack/ez-agents`. Approved beta publications use npm's
`latest` distribution tag while their versions and GitHub releases remain
prereleases. For a reproducible download, choose an exact version from
[GitHub prereleases](https://github.com/jdorado/ez-agents/releases) and substitute
it for `VERSION` in `npm pack @jc_stack/ez-agents@VERSION`.
You can also download the release's candidate tarball and verify its SHA-256
against the attached release receipt or release notes.
GitHub remains under `jdorado`; npm uses `jc_stack`. Do not install the unrelated
unscoped `ez-whatsapp` package.

Installed runtime operation uses Docker Compose. Docker owns relay/plugin
services; the existing host CLI and login are shared through one generic
transport, with separate agent workspaces and sessions. See
[Docker setup, state and QA](docs/docker-runtime.md).

For optional PagerDuty paging of a critical Stocks outage, see
[PagerDuty critical-outage paging](docs/pagerduty.md).

For independent agent check-ins and concise incident context, see
[Workforce Watch](docs/workforce-watch.md). It runs separately from relays and
does not receive their executor or provider credentials.

Telegram `/status` shows the running relay and host versions plus installed
plugin versions. Its read-only **Scheduled tasks** control lists the paired
owner's active schedules in alphabetical order, with their engine/model/effort,
next occurrence or current queued/running state, and a short preview of the
saved invocation prompt; it never creates, changes or runs a task. The agent's `ez status` adds verified plugin
runtime states and upgrade job receipts. See [status and upgrades](docs/upgrades.md).

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
| `ezenciel-agents-create --name <name> --purpose <agent-brief>` | Create an agent from the installing LLM's compact brief; packaged Codex defaults isolated, other CLIs stay host-capable; token via stdin |
| `ezenciel-agents-create --name <name> --purpose <agent-brief> --isolation host-capable` | Explicitly reuse the host CLI and installer UID |
| `ezenciel-agents-host` | Invoke the existing shared host CLI for this deployment |
| `ezenciel-agents-setup configure <executor> --purpose-file <path>` | Private configuration and missing starter files; fresh workspaces require installer-scoped purpose; preserves personal files |
| `ezenciel-agents-setup configure <executor> --purpose-file <path> --token-stdin` | Same, with the BotFather token supplied privately through stdin |
| `ezenciel-agents-setup service` | Start only the Docker relay bound by `docker.env` in the current directory; register the [host service](docs/host-service.md) separately |
| `ezenciel-agents-owner status` | Inspect the owner and pending pairing requests |
| `ezenciel-agents-owner approve <telegram-user-id>` | Approve the verified owner; never an arbitrary first sender |
| `ezenciel-agents-setup status` | Inspect installed executor choices |
| `ezenciel-agents-setup init --purpose-file <path>` | Seed missing workspace guidance; purpose is optional only when AGENTS.md already exists |

Run runtime tools through `ezenciel-agents-docker run --rm relay <command>`
as shown in the Docker guide. Keep the Docker engine available; Compose owns
restart and shutdown. Host-capable agents register the small host CLI transport with the native service manager. Isolated agents do not.

## Runtime and development reference

The selected host CLI runs in this agent's persistent workspace and owns its
Markdown/work files. New conversations and AI changes preserve those files.
One compact `AGENTS.md` is seeded with the installer purpose; `MEMORY.md` is
optional. The installing LLM authors the initial brief from the owner's request
and known application context; Ez stores it without trying to infer the product
itself. Installed plugin snippets and skill paths come from the bound
`ez tools list --details` locator; no tool inventory file needs maintenance.
Credentials and control state stay outside the mind. Isolated agents use relay
mounts as the filesystem boundary. Host-capable file separation is not OS
isolation against a process running as the same user.

In Telegram, **Conversations** (or `/chats`) lists this agent's saved Ez
conversations by name. Tap a name to continue its native engine session and
restore its AI choice. Names start with the first message; `/rename Client launch`
sets a custom name for the current conversation. **New conversation** keeps the
old one available. **Archive this conversation**, shown after selecting a name, hides a conversation without deleting its engine
history; **Archived conversations → select a name → Restore conversation** brings it back. Archiving the current conversation
leaves the next message to start a fresh one. Running and queued work stays bound
to its original conversation; archive does not cancel work.

Agents can inspect what was sent to the bound Telegram chat across conversations
with `ezenciel-agents-message history` (latest 8 deliveries), `--limit N` (1–50),
or `--message-id ID` for a specific message, including a chunk of a longer report.
This read-only command requires an active owner Telegram run and returns confirmed
local receipts with message IDs, delivery times and source run/session references.
It does not change the selected conversation or inject history into prompts.
Only retained receipts from the current owner binding are available; Telegram
edits/deletions and attachment contents are not fetched.

Existing conversations without a title show their first saved message and date when
available. Empty routing placeholders are omitted from history; + New conversation
is the create action. Back updates the current menu without creating a conversation. Use /rename for a custom name. Older
records without a saved model reuse a known choice for their original CLI.
Antigravity's latest-only resume cannot switch back to an older conversation.
The list covers sessions already tracked by this Ez agent; it does not import
unrelated GUI/CLI history. Application-backed channels keep session controls in
the connected application. Shared workspace files still persist across topics.


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
- [Plugin author guide](docs/plugin-guide.md)
- [First plugin and extension contract](docs/plugins.md)
- [License and dependency notices](THIRD_PARTY_NOTICES.md)

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](docs/upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.

### Scheduling and background work

The core `ezenciel-agents-schedule` CLI accepts instruction text for one-off dates,
intervals and timezone-aware cron schedules. `create --now` delegates a task to a
separate CLI session so the owner conversation remains available. Long work has
no production wall-clock timeout; goals and subagents remain native executor
features. See [scheduling, recovery and QA](docs/scheduling.md).
