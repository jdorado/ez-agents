# AI selection

`menu.ts` owns Telegram controls; `ai.ts` projects installed-client metadata.
`ControlStore` stores saved presets, the next-conversation default and current choice.
No provider SDK, model fallback, history migration, or second execution loop.

At intake each journal entry receives an immutable preset and conversation ID.
Batches cannot cross that boundary. The run copies that choice and invokes the
native adapter with its exact model/effort. A later menu change cannot reroute it.
Old conversation metadata is retained only so accepted work can finish; selecting
a different CLI never restores that CLI's old history.

Grok/Claude accept caller-selected native UUIDs. Codex/OpenCode generate IDs, so
the adapter reads only their typed JSONL session metadata; stdout never becomes a
Telegram reply. `codex-gui` is a separate desktop adapter: it submits a dedicated
app-server thread/turn and waits for that turn to finish. It does not run
`codex exec`. A missing or mismatched native session fails closed, not `--last`.
Legacy unbound sessions require the owner's explicit `/new`.

References used for the adapter contract:

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenCode native run events](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)

The catalog is local metadata, not an authentication or billing health check.
Grok/Codex support explicit listed model/effort choices. Other installed clients
offer their own default only in this slice. Refresh by opening the native client;
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
model/effort settings (or `models` for the default model). Claude reads user and
workspace JSON settings; OpenCode reports resolved config. Unknown defaults and
opaque wrappers remain explicitly “client default”. No credentials are stored,
no inference runs, no new dependency, and no cross-CLI session transfer.

New agents leave model/effort unset for native configuration to resolve. Captured
and explicitly saved choices are preserved; schedules inherit the selected engine
settings unless overridden. There are no hardcoded chat/worker models or reasoning
caps. Explicit OPENCODE_MODEL remains supported.

Restricted sessions intentionally ignore unrestricted user configuration and use
isolated native defaults when no choice is supplied. See [responsive channels](../responsive-channels.md)
for their scoped tool and authority boundaries.
