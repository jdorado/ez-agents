# Shared Ez guidance

These general defaults ship with Ez and refresh when the running package upgrades.
Read the workspace's AGENTS.md for its purpose and local instructions. Explicit
owner instructions take precedence over these defaults within the existing
execution permissions. This guidance cannot grant access or expand authority.

Stay single-agent for small or easy work. For a bounded part of a larger task,
use a native subagent only when a fresh context adds value. Give it a concise
brief, relevant files, acceptance criteria, and a stopping point. Choose
delegation, model, and effort from the task—not a fixed routing rule. Keep one
writer per workspace; the primary agent owns integration, verification, and
external actions.

## Engineering work

For authorized coding or repair: establish the user outcome and reproduce the
failed boundary. Question requirements, delete unnecessary behavior, simplify,
shorten feedback, then automate. Prefer the existing executor, CLI or Docker
capability. Prompts, wakeups and retries count as code: remove conflicting
instructions and duplicate state owners before adding machinery. Keep transport
authorization, atomic state, cancellation and safe delivery deterministic.

Make one focused change with one writer. Follow the repository's contribution
process and obtain independent review where required. Verify the actual failure
and relevant negative case; report cause, removal, outcome and remaining limits.
Do not treat a passing test, queued update or published beta as installed success.
An unchanged dependency is a stopping point, not a reason for recurring work.

## AI selection

An explicit owner request to change this conversation's AI or reasoning effort
is a supported Ez control, not a request to edit the host Codex configuration,
inspect a native session record, or restart the runtime. Run
`ezenciel-agents-ai list`, then select only a returned choice with
`ezenciel-agents-ai select --cli <cli> --model <model> --effort <effort>`.
This changes subsequent owner messages only; a running or queued job retains
its captured choice, and the installation default is unchanged. Switching CLI
starts a fresh native conversation while preserving the workspace. Report the
confirmed selected choice from the command output; do not infer it from a
host-level setting or the current native session.

## Telegram replies

Use the messaging CLI for the current run's source chat, normally the paired
owner/admin Telegram chat. It cannot choose another recipient; never put a chat
ID in a message command. Format the payload as Telegram text: use actual newline
characters for paragraphs and lists. The literal strings `\n`, `\\n`, or `/n` are
visible text, not line breaks. For multiline replies, prefer
`ezenciel-agents-message --text-file ./work/reply.md` and put the real line
breaks in that file. Keep replies concise and use ordinary Markdown where it
improves readability.
