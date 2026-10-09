# AI selection

`menu.ts` owns Telegram controls; `ai.ts` projects installed-client metadata.
`ControlStore` stores saved presets, the next-conversation default and current choice.
No provider SDK, model fallback, history migration, or second execution loop.
A missing catalog entry rejects selection without changing the conversation.
An unsupported effort reports the exact installed model's advertised levels.
Missing selectable models do not establish that the active native session is
unavailable, and editing a scheduled task does not change the chat selection.

At intake each journal entry receives an immutable preset and conversation ID.
Batches cannot cross that boundary. The run copies that choice and invokes the
native adapter with its exact model/effort. A later menu change cannot reroute it.
Each named conversation saves its model and reasoning level. Switching back through
`/chats` restores that choice and the exact native session, including after restart.
`/ai` shows the current choice and saves changes immediately. Changing model or
reasoning level on the same client and provider preserves the conversation's name
and native history; subsequent turns pass the new settings to the native engine.
Changing client, provider or auth profile starts a separate native conversation.
A conversation records its client and auth profile when created; launch rejects a
choice for another profile, so a native session never resumes under another
account. Provisioned profiles appear as additional catalog entries for their
client (see [auth profiles](../docker-runtime.md#auth-profiles)). Old bindings
remain available so accepted work can finish and owners can reopen their chats.

Grok/Claude accept caller-selected native UUIDs. Codex/OpenCode generate IDs, so
the adapter reads only their typed JSONL session metadata; stdout never becomes a
Telegram reply. `codex-gui` is a separate desktop adapter: it submits a dedicated
app-server thread/turn and waits for that turn to finish. It does not run
`codex exec`. If the native control socket is absent, the adapter asks the
installed Codex CLI to idempotently start its own app-server daemon, then retries
the connection once. It does not implement another daemon or fall back to the
headless CLI. A missing or mismatched native session fails closed, not `--last`.
Native server requests use their method-specific response schema. Scheduled turns
use on-request approval routing so browser elicitations reach the adapter, which
accepts only the active turn's session-scoped HTTPS browser-origin and Computer
Use Chrome app requests. Interactive turns remain non-interactive. Audio,
cross-turn, command, file and unrelated requests are declined rather than being
guessed or forwarded to a hidden task UI.
Legacy unbound sessions require the owner's explicit `/new`.

Like Codex's `CODEX_HOME`, Claude runs with an agent-bound `CLAUDE_CONFIG_DIR`
(`control/cli/claude`): settings, memory, plugins and sessions belong to the
agent, never the operator's `~/.claude`. Host-capable agents share only the
installer's OAuth/subscription login by setting `CLAUDE_SECURESTORAGE_CONFIG_DIR`
empty, so Claude reads and refreshes its default credential store in place. API
key, `apiKeyHelper` or provider `env` setups in the operator's `~/.claude` are
not shared; put them in the agent-bound directory instead. Isolated agents log in
inside their own config directory. Claude conversations started before this
binding live in the operator's `~/.claude` and need `/new`.

References used for the adapter contract:

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenCode native run events](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)

The catalog is native metadata, not an authentication or billing health check.
Codex refreshes through `codex debug models` with the whitelisted executor
environment and the execution-bound `CODEX_HOME`; discovery starts no session
or inference. Only visible model names and supported efforts are projected.
Unavailable discovery retains the native cache. The installed native version
still owns which models it advertises; Core never guesses newly released aliases.
Grok/Codex/OpenCode/Claude support explicit listed model/effort choices. Claude has
no catalog command, so the installed `claude --help` is its native metadata: the
documented model aliases and `--effort` levels are listed alongside the client
default; unparseable help keeps the client default only. A versioned model name (for example
`claude-sonnet-5-5`) is offered by adding a `claude` entry to the agent's curated
`control/ai-models.json`; the alias `sonnet` always means the client's current Sonnet. Other installed clients
offer their own default only in this slice. OpenCode lists the installed `opencode models`
catalog with the whitelisted executor environment, so only models the relay can actually
run are offered; provider variants become selectable efforts (`--variant`).
Authenticated providers appear only when the agent-bound
`control/cli/opencode/auth.json` binding exists (host runs keep the installer
login); otherwise the free tier lists. `EZ_OPENCODE_PROVIDERS` optionally
restricts the catalog to named providers (e.g. `opencode-go`); a set
allowlist that matches nothing offers no OpenCode choice rather than falling
back outside it. Codex discovery refreshes directly; for other cache-only
catalogs, refresh by opening the native client;
the relay does not install models, manage subscriptions or guess aliases.

Setup initialization and relay startup seed one default choice per installed client.
Choose AI shows the three most recent valid choices and installed clients, then
the selected client's models and reasoning levels. Selecting a model and reasoning
level applies that choice immediately. The retired Settings control points to
Choose AI; application-backed channels keep these controls in their application.
Refresh available AIs repeats default discovery. Active/default
presets and queued snapshots are preserved; discovery only refreshes unused
detected entries.
Codex uses its native `config/read` interface; Grok reads its documented user
model/effort settings (or `models` for the default model). Claude reads the agent-bound
user settings and workspace JSON settings; OpenCode reports resolved config. Unknown defaults and
opaque wrappers remain explicitly “client default”. No credentials are stored,
no inference runs, no new dependency, and no cross-CLI session transfer.

New agents leave model/effort unset for native configuration to resolve. Captured
and explicitly saved choices are preserved; schedules inherit the selected engine
settings unless overridden. There are no hardcoded chat/worker models or reasoning
caps. Explicit OPENCODE_MODEL remains supported.

Restricted sessions intentionally ignore unrestricted user configuration and use
isolated native defaults when no choice is supplied. See [responsive channels](../responsive-channels.md)
for their scoped tool and authority boundaries.
