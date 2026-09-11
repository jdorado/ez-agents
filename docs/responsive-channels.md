# Responsive channels

Ez treats conversational channels as places to answer, clarify and hand off
work. A simple question uses the current conversation; a small authorized action
uses its canonical receipt. Substantial work gets a durable task with enough
context to finish and verify the job. The agent returns to conversation after
the handoff is saved, instead of waiting for the worker. This is agent guidance,
not a keyword classifier, automatic acknowledgement, or latency guarantee.

New Codex agents use Sol / medium for chat. Scheduled work defaults independently
to Terra / high; the agent can choose another model and effort for complex work.
`ezenciel-agents-schedule create --now --text-file FILE --model MODEL --effort high`
uses the existing scheduler (include `--name` for a useful task label). Busy owner
reply sessions expose the same independent model/effort choice through `defer`.
Its retry returns the first saved schedule; changing arguments does not revise
an accepted job. Explicit effort above high remains rejected by core policy.

A handoff includes the objective, relevant context and paths, constraints,
authorized actions, acceptance checks and delivery destination. Background
sessions own verification and final delivery, and may use native subagents.
One writer per workspace still applies. Shared external resources require
coordination even when task directories differ. Status must distinguish a saved
schedule from actual execution and a verified result from a process exit.

The package loads `templates/chat-guidance.md` at each turn for CLI, desktop,
busy owner replies and approved plugin messaging tasks. Upgrades refresh this
behavior without rewriting the agent's personal files. Existing model choices
remain pinned; an upgrade adds Responsive chat as an available selection.

## Channel and authority boundaries

Telegram owner conversations can schedule work under the owner's authority.
The existing restricted busy-reply session keeps Codex chat available while a
writer is active. Other executors retain their existing concurrency behavior.

WhatsApp and other plugin contacts use the approved messaging task's isolated
context and tools. They receive the conversational guidance and Sol / medium
selection, but cannot invoke owner schedules, shell tools or native subagents.
They report work outside their capabilities to the owner; that report is not
an instruction or permission to execute. Full delegation from a plugin contact
needs an explicitly scoped worker capability and return route; this update does
not grant one. The plugin name alone never confers owner authority.

An application using `channelBackendUrl` owns its conversation, model and job
lifecycle. The relay does not inject prompts or override the app's model. Such
backends (including AI Fit) must adopt the same handoff policy in their own
runtime to benefit. Reuse their canonical job system; do not create a second
agent in the transport. Telegram polling and app-side queue waits still count
toward user-visible latency.

## Verification

Tests cover independent worker settings, preserved selections across upgrades,
idempotent handoffs, invalid settings, revocation and restricted tool boundaries.
Existing scheduler/host tests cover a conversational reply while work remains
active. Measure time to the first useful reply and verified task completion
separately on the deployed provider before claiming a performance improvement.
