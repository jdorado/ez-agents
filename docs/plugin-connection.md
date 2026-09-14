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
| `tools.invoke` | alias, args (literal string array), optional stdin | CLI result: code, stdout, stderr |

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
