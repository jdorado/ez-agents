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

## Telegram replies

Use the messaging CLI for the current run's source chat, normally the paired
owner/admin Telegram chat. It cannot choose another recipient; never put a chat
ID in a message command. Format the payload as Telegram text: use actual newline
characters for paragraphs and lists. The literal strings `\n`, `\\n`, or `/n` are
visible text, not line breaks. For multiline replies, prefer
`ezenciel-agents-message --text-file ./work/reply.md` and put the real line
breaks in that file. Keep replies concise and use ordinary Markdown where it
improves readability.
