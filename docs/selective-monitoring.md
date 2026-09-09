# Selective monitoring and replies

An owner saying “monitor and answer messages from CONTACT” has selected that
contact and authorized ordinary replies within the stated scope. Do not ask
whether they meant selected contacts or demand a special phrase. “If they send,
reply” means wait for incoming messages; it does not authorize an opening send.
Resolve only missing identity or disclosure scope. A saved Markdown instruction
is a reminder, never an activated source, watch or reply permission.

## Speak in jobs, not modes

Keep mode names internal. Linking/syncing an account defaults to quiet capture;
finish connection verification, then at most one short optional prompt such as
“WhatsApp is connected. Want me to follow up with anyone?” Do not present a
technical three-mode menu or suggest blanket autonomous replies that v1 cannot
safely authorize. If the owner already gave a job, continue it without this prompt.

Infer the complete job from ordinary language:

- “Find out whether they have a table” or “Book me a restaurant”: send the inquiry,
  watch replies from that contact, continue the multi-turn negotiation and report
  the outcome. A send receipt is not completion. Do not ask if follow-up is wanted.
- Twelve inquiries mean twelve task-scoped contacts, not all-inbox monitoring.
  Maintain one scoped task per correspondent; the same core checks apply to each.
- “Just send this; I will reply”: one-off send under the explicit owner instruction,
  no new watch or conversational mandate. Use the provider's ordinary send and
  receipt interface; do not create a messaging task that would auto-follow up.
- “Monitor this person and answer if they message”: incoming-only reply task;
  no opening message and no unrelated contact attention.
- “Keep these messages for me”: quiet capture/read-on-request. If “monitor” alone
  leaves action intent unclear, ask one plain question: “Should I reply for you,
  or just keep the messages for you to review?” Do not ask when the job resolves it.

Apply the required core confirmation to the concrete proposal, not an extra
questionnaire. Use the owner's existing contact, purpose and disclosure limits.
Avoid claiming indefinite service where v1 is bounded. Explain the expiry only
when it matters to that proposed job; never silently expand or renew permission.

## Three capture modes, separate reply authority

- Manual: capture for explicit reads, with no general wake-up subscription.
- Selected: wake for named contacts only. Never turn on all-inbox mode to satisfy
  a one-contact request.
- All: attention for all eligible incoming contacts; requires that broader
  owner request. Attention alone never grants autonomous reply permission.

For an approved core reply task, the provider's task-watch supplies expiring
selected attention even if its general policy remains manual. That is expected:
verify the actual task watch and core grant, not only the general policy label.
Monitoring-only requests grant no sends. Unsupported wake-only reasoning modes
must be reported as unsupported, not run with owner authority.

## Complete the setup under the owner's request

Use the current installed plugin skill and `ez plugins list`/`status`/provider
doctor to confirm the existing linked account. Installation, source plumbing,
contact attention and permission are separate checks. A missing source is
technical work for the agent, not a reason to stop at “saved your instruction.”
Do not request a second provider instance or re-pair an already linked account.

The relay must be able to reach the registered provider service socket. Inspect
the registered deployment/compose, actual named IPC volume, and relay mounts.
For the supplied WhatsApp adapter the socket is /plugins/whatsapp/service.sock;
main compose.whatsapp.yaml supplies a read-only IPC/client override. Use the
registered plugin's real volume names, preserve existing docker.env/Compose
settings, and attach only its declared IPC/client volumes (never its profile or
credentials). Recreate the relay with the existing deployment after a required
mount change; verify it comes back. Do not expose the Docker socket to it.

Register the source INSIDE that relay container using the installed
`ezenciel-agents-source --name NAME --socket ABSOLUTE_SOCKET` command. Read back
registration and provider events-head account identity. A socket inside a
provider command container is not proof the relay can reach it. Do not edit core
source/grant JSON directly. Other adapters use their declared socket paths;
provider names do not change authority checks.

## Propose, confirm, verify

For an outbound job such as a booking, use `ezenciel-agents-task propose` WITHOUT
`--incoming-only`: it starts the inquiry and then watches replies. For “answer if
they message,” use `ezenciel-agents-task propose --incoming-only` with the
registered source, canonical contact, purpose, explicitly shareable context file
and expiry. No need to invent a booking objective: “conversational replies to
this contact, no private disclosures or commitments” is a legitimate purpose.
If no private facts may be shared, say so in the context file; do not include
owner memory. V1 supports at most 72 hours, not indefinite “until stopped.” Offer
that bounded duration in the exact approval, explaining the limit without asking
the owner to restate their request. Do not silently renew it.

The core presents the exact proposal for owner confirmation. Ordinary messages
inside that grant need no repeated confirmations. Incoming-only grants create
no initial run or opening message. They remain active across replies until expiry
or owner revocation; the worker cannot close a watch by calling `complete`.
After handling a message, save a task note and finish the run. After approval, verify active core state,
contact and expiry, source reachability, and the provider's task watch. With
`--incoming-only`, an empty conversation is correctly idle until a new message.
If approval is still pending, say pending; if setup failed, name the actual
failure and continue repair within scope. Never report “active” based on notes,
installation, connected status or subscription alone.

After an authorized test message, inspect the corresponding task run and send
receipt and compare recipient readback. An accepted send is not proof of delivery.
After revocation/expiry no subsequent reply may dispatch. Keep these checks
agent-owned: the owner supplies only necessary confirmation, QR scan if needed,
and the test contact/message. Do not bypass a missing grant by polling the inbox
in an unrestricted scheduled owner session or sending through the raw CLI.
