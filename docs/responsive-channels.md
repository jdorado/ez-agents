# Responsive channels

Owner input passes unchanged to the selected engine. When work can continue
independently, the global managed guidance tells the agent to prefer an immediate
scheduled turn so the foreground channel remains available. The agent still makes
that choice; ez does not infer task duration or auto-schedule work. ez queues
foreground input while a foreground run is active; it does not create a separate
busy-reply agent.
Owner-scheduled turns run independently of the foreground channel stream, so a
long review does not block chat. Each stream runs one turn at a time. They share
the agent-owned workspace, but use separate native sessions; session isolation
does not isolate Markdown files. The agent coordinates shared file updates and
plugins enforce their canonical record-write contracts.

Background tasks receive literal task text. Their native sessions contain no
generated role instructions or copied identity files; native workspace instructions
and existing Markdown provide context. The agent chooses what to read and when to use
the message CLI. Native final text is not automatically delivered to Telegram.

Restricted correspondence receives a typed activation event and scoped tools.
Authorization, sandboxing and tool handlers enforce contact and lifecycle limits.
An owner-approved channel capability adds only a fixed installed alias declared
as a read-only channel query; it does not expose the workspace, shell, owner
session or other installed tools.
Group notifications carry event data; CLI help owns operations.
