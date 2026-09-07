# Security

Supported scope: the latest release, one paired Telegram owner per agent on a
trusted host. Unknown senders/groups cannot acquire execution authority.
The host CLI and plugin manager run with the host user's authority, including
Docker administration. Environment filtering and container profile separation
reduce accidental exposure; they do not isolate a hostile process from its own
host user. Markdown roles and approvals are instructions, not an OS sandbox.
Do not expose this as a public multi-tenant execution service.

Keep Telegram tokens, device profiles, QR images, control state and native CLI
sessions outside source and mind files. Treat incoming provider content as
untrusted data. Do not bypass owner checks or silently retry uncertain writes.

## Reporting

On the public GitHub repository use Security → Report a vulnerability (private
vulnerability reporting). Before publication the maintainer must enable and
verify that channel. If it is unavailable, open an issue asking only for a private
contact route; do not include exploit details or sensitive attachments publicly.
Include affected version, sanitized reproduction, impact and suggested fix.
There is no paid response SLA. Only the latest release receives fixes; report
older-version findings with a reproduction on the latest version when possible.

Current support target: the latest beta on a trusted single-user host. Report
privately at https://github.com/jdorado/ez-agents/security/advisories/new.
