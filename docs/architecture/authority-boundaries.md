# Authority boundaries

The core pairs one Telegram owner and owns authority across providers. Plugins
provide transport, authentication, capture, and receipts. Their exposure metadata
is discovery information, never a grant. A CRM can contain external text too;
marking it internal does not confer owner authority.

## Messaging v1

The owner asks the agent to contact one person for a bounded purpose. The owner
agent prepares a proposal with `ezenciel-agents-task propose`: registered source,
exact canonical contact, purpose, explicitly shareable context, and expiry (up to
72 hours). Telegram displays that exact proposal for approval. The core binds it
to the verified owner, current source registration, and connected account. The
owner does not edit JSON. The agent uses `list` and `revoke` when asked.

After approval the relay starts a restricted task, including the initial outgoing
message. Incoming-only tasks instead wait for new correspondence and never create
an opening run. Their task records use version 2 so older task readers fail closed. Matching new correspondence resumes that task in a fresh native session.
Other contacts remain blocked unless an owner-approved any-conversation grant is
active for that source. Finite tasks have at most 30 distinct text sends;
there are no payments, attachments, extra recipients, plugin installation,
settings changes, or access to owner memory. A contact can have one active or
pending task at a time. Completed, revoked, expired, replaced-source, and changed-
account grants cannot dispatch further messages.

The worker receives only the approved dossier, its notes, its operation receipts,
and rechecked correspondence for its contact. All dossier contents may be shared
with that contact. The agent judges how to pursue the purpose; code does not prove
that each sentence serves the booking or that a correspondent is truthful. A
prompt injection can still derail a task or elicit its shared context. It cannot
use the provided tools to read owner files or select another destination.

## Channel audiences and capabilities

Version-4 grants may bind the audience to every conversation captured by one
registered event source. The source must advertise `wildcardWatch` and implement
`task-watch`/`task-unwatch` for conversation `*`. The grant is incoming-only and
active until owner revocation. It does not grant other sources, owner controls,
the owner session, owner files or conversation history. Each run contains events
from exactly one provider conversation, replies only to that captured
conversation and exposes no cross-conversation notes. Exact-contact grants remain
the default.

A channel grant may include up to eight owner-approved query capabilities. Each is an
exact registered `ez` command plus fixed arguments ending in literal
`-- {input}`. The restricted broker replaces only `{input}` with the
correspondent's string; the model cannot select a command, prepend flags, choose
a recipient, access a shell or change the fixed arguments. The full command
vector and disclosure scope appear in the immutable owner approval. Core rechecks
the grant immediately before and after invocation and before every reply. The
installed alias must declare `channelQuery: true` and explicitly declare that it
accepts external input without external sends, record changes, or interactive
review; core revalidates this trusted installed manifest before execution. Output
is bounded to 128 KiB and may be disclosed to the approved audience; stderr and
process credentials are not exposed. Tool output and incoming messages remain
untrusted source material.

Capabilities are a core channel permission, not a plugin permission system.
Domain tools remain ordinary reviewed CLIs and enforce their own authentication,
resource authorization, validation, persistence and receipts. For example, an
installed Library can supply a dedicated fixed read-only search alias. Do not
grant lifecycle/admin commands or an operation with
unbounded or uncertain external effects through this query-shaped interface.
Those require a purpose-built tool contract with its own idempotency and receipts.

## Ongoing conversation permissions

Incoming-only proposals may use `--until-revoked` for an ongoing conversation.
This is a provider-neutral version-3 grant using the same owner, account, source,
conversation and disclosure checks. It has no total reply count or time expiry.
A 30-send ceiling applies per incoming run to bound runaway output, not per grant.
Receipts stay durable; current-run keys are namespaced to avoid collisions with
later replies. The runner gets current-run receipts and rolling group-only notes
(up to 16,000 characters), not the owner's private session or files. Providers
receive the largest supported timestamp for the watch; the core still checks
revocation before every operation. Older versions reject version-3 grants.

The native Telegram source implements the provider protocol for exact private or
group IDs and wildcard audiences. It records selected text messages and sender
identity, and sends only to the concrete captured chat with durable
uncertain/accepted receipts. Bot messages and
anonymous-admin posts are excluded by intake. Unselected owner group text remains
private discovery; other unselected group messages cannot launch work. Source
registration enables discovery, never reply permission. Voice and attachments are
not handled by this group adapter. WhatsApp continues using its existing adapter;
group, ongoing and wildcard watch support depends on the companion provider. Older
adapters reject ongoing grants at proposal time. Pending watch removals retry
after service outages; core revocation blocks sends immediately.

## Native execution and core tools

V1 uses audited Codex CLI **0.153.4** for task work, regardless of the owner's
selected executor. Missing or different versions fail closed; upgrading this pin
requires repeating the native tool inventory test. Owner work retains its normal
executor. The task runner creates a fresh ephemeral home/session, skips user
config, rules and ancestor project instructions, and disables shell, file/image,
browser, apps, hooks, memory and agent spawning tools. A native permissions
profile denies general filesystem access and tool network access. No owner
workspace or conversation is passed to this runner. The runner uses the pinned
CLI's bundled model catalog with task-specific tool defaults: direct MCP calls,
no model-added patch tools, experimental tools or collaboration, and no deferred
tool discovery. Model metadata can override feature flags, so flags alone are
insufficient. The native inventory test uses a real bundled model entry and must
prove the five bounded task tools work without additional action tools.

A core stdio MCP broker exposes `context`, `send`, `note`, `report`, and `complete`,
plus only the exact capabilities recorded in the grant. Any-conversation runs omit
cross-conversation note/report/complete tools.
The native client also lists resource helpers, but the broker serves no resources.
Only these tools have native approval bypass configured: the core rechecks
the grant on each call. Broker requests cross host/relay through private atomic
control files; only the relay dispatches provider writes. Model tool arguments
never choose a recipient, account, control path, shell command, or permission.
The native harness and broker are trusted processes; this is model-tool
containment, not isolation from a malicious native executable or local host user.
Native configuration reference: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

Task notes live under protected `control/tasks/`, separate from the owner mind.
Exact-contact task reports currently use the linked Telegram owner outbox and
are visibly labelled; any-conversation runs have no report tool. Reports are not
inserted as owner instructions or trusted memory. The owner mind
keeps its existing `inbox/` and `work/` organization. No database or general memory
index is introduced.

## Provider protocol

A registered Unix event source advertises `taskProtocol: "message-v1"` and a
stable string `accountId` in `events-head`. The core calls `task-watch` with that
account, exact `conversationId`, and expiry to request bounded capture attention.
The existing events/events-check protocol supplies incoming messages. This
subscription grants attention only; execution still requires the core grant.
Sources that support an any-conversation grant additionally advertise
`wildcardWatch: true` and accept `*` only for watch/unwatch, never as a send target.

For sends the core supplies `task-send` with those same bound IDs, text, and a
core-prefixed idempotency key. The adapter checks account consistency immediately
before provider dispatch and returns `{accountId, conversationId, key, state:
"accepted", receiptId}`. Acceptance is not delivery or booking confirmation.
The WhatsApp adapter implements this protocol for individual contacts. Another
provider, including a Gmail/Composio adapter, can implement the same transport
contract without implementing authority policy; those adapters are not supplied
by this change.

Before dispatch the core durably records an uncertain operation. A validated
receipt changes it to accepted. Crashes, timeouts, malformed receipts and lost
responses remain uncertain; replaying the same key does not send again, and a
changed payload under the same key is rejected. The agent must report uncertainty
for owner inspection. V1 has no automatic uncertain-send reconciliation. Core
revocation and send acceptance are serialized; revocation cannot undo a message
already dispatched. Expired task watches may still leave captured provider
records, but cannot launch task work.

## Compatibility and limits

Unmatched events retain terminal `cancelled` plus
`external-execution-unavailable`. Task runs use record version 2; older readers
reject/skip them instead of executing them with owner access. Existing version-1
owner runs remain readable. Older task readers reject version-4 wildcard grants;
approval prompt changes also fail closed if a capability-bearing older record is
read after rollback. Package state schema stays 1, but rollback suspends
task processing until a task-aware version returns; rollback does not replay
messages or erase task receipts. Update host and relay together. A missing or
outdated host fails task launch closed.

The installing host user remains trusted and can modify local control state.
Owner runs can use the plugin manager and Docker administration; content read
inside owner work still depends on native protections and agent judgment. This
is an owner-configured channel service, not a general multi-tenant execution
platform. Payments, enterprise reviewer agents, arbitrary file sharing and
unrestricted delegated executors are deferred.

Verify with `pnpm verify`, Docker test/runtime targets and smoke fixtures.
`EZ_TEST_NATIVE_TASKS=1 pnpm exec tsx --test test/task-native.test.ts` checks the
actual pinned native tool inventory and executes a synthetic model/broker/provider
conversation without real credentials or external sends. Real Telegram-owner to
WhatsApp-correspondent acceptance remains separate live QA requiring an
authorized account/contact.

For plain-language intent, onboarding defaults and source setup see
[selective monitoring](../selective-monitoring.md).
