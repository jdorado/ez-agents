# Persistent plugin connection

`ez tools connect <installed-alias> <literal arguments...>` attaches one Compose
command container for a local, agent-bound client. It releases the registry lock
after admission. Ordinary JSON objects travel as JSONL between client and plugin;
this transport owns no inference, conversation history or plugin-specific tools.
The local owning connection uses the agent's installed plugin permissions, just
like its bound CLI. A remote or web adapter must authenticate its owner before
connecting and protect its stdin. Plugin commands retain their own authorization;
the connection adds no per-command permission prompt.

Plugin requests use `{"coreRequest":{"id":"r1","method":"tools.list","params":{}}}`.
Core answers `{"coreResponse":{"id":"r1","result":...}}` or `error` (a string).

| Method | Parameters | Result |
| --- | --- | --- |
| `tools.list` | none | Array of alias, plugin, description, skillCount, revision |
| `tools.help` | alias | CLI `--help` result: code, stdout, stderr |
| `tools.skill` | alias, index, optional line | Declared skill text and nextLine; index starts at zero, line at one |
| `tools.invoke` | alias, args (literal string array), optional stdin and output filename | CLI result: code, stdout, stderr; optional artifact path, bytes, sha256 |
| `tools.native.list` | none | Core command descriptions and availability |
| `tools.native` | command, args (literal argument array) | Native CLI result: code, stdout, stderr |

`tools.native` invokes only the shipped `schedule` or `message` CLI, using the
owning host's verified workspace/control binding and a whitelisted environment.
Read `--help` for its command contract; this connection requires inline `--text`
and rejects `--text-file` so it cannot read arbitrary host files. `create --now` submits standard
asynchronous native work; it does not launch a second runner or hold the workspace
lease while waiting. The native agent may retrieve a Library original, inspect it
with its existing image/PDF tools, and save source-linked searchable text.
Scheduler owner checks, selected engine, cancellation and receipts remain native.
No synthetic run context is injected. Standalone bindings cannot use this method;
task creation without a Telegram owner or authenticated originating channel still
fails under the scheduler's existing delivery rule. Results can be inspected with
`runs` and `run RUN_ID`; a completed run alone is not proof of indexed content.

Message delivery captures the paired owner and pairing epoch when the connection
opens. Core injects that context; tool arguments cannot select a recipient or
replace it. The message CLI enqueues the existing outbox without creating an agent
run, and the relay rechecks the owner before sending. Revocation or re-pairing
invalidates the connection. Inline text and workspace documents use the same
Telegram delivery and receipt path as native runs. Text-file input is unavailable.
History still requires a native run; `message receipt OUTBOX_ID` reconciles a
channel send against the current owner's outbox. Sends return a queued ID then
wait up to 20 seconds for delivery; queued or unknown never means sent, and must
not be retried without receipt readback. An accepted send may finish after the
voice connection closes. Omitting command retains schedule compatibility.

For binary plugin output, supply a simple `output` filename. Core saves at most
20 MiB of stdout in a unique private workspace artifact and returns its relative
path, byte count and SHA-256 instead of binary model text. Only successful command
output is saved. The message CLI can send that path with `--document`; both host
admission and relay delivery enforce workspace containment.

The registry is read on each request. The connected plugin is excluded, including
its other aliases. Skill reads stay within its declared source directory and
return at most 100 lines. Invocations execute once through the registered binding;
a changed plugin revision requires rediscovery. Client stdin cannot forge core
requests or responses. The plugin may send `coreCancel: {id}` to cancel its own
pending request. Request IDs cannot be reused within a connection.

Commands use the existing bound Compose dispatcher, literal argv and whitelisted
environment. Calls have a 30-second timeout and 256 KiB combined output limit;
connection frames are limited to 1 MiB. Connection closure aborts pending calls
and removes their exact command containers. There is no automatic retry.

Arbitrary calls take the same fail-fast workspace lease as non-scheduled native
jobs. Native work stays pending while a call runs; calls refuse pending/running
native work. Ordinary CLI calls inside an admitted native job do not reacquire
the lease. Isolated scheduled work keeps its existing workspace behavior. A stale
native `workspace-writer.lock` is recovered at host startup only after its host
owner is dead and startup has checked previous native processes. A stale plugin
lease stops admission with an explicit error: an operator must verify its command
containers stopped before removing the lock. A dead bridge alone is insufficient.
This guard requires the updated host worker. Direct external writers are outside
the managed admission boundary.
