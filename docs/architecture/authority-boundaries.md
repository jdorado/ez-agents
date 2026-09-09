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
Other contacts remain blocked. Finite tasks have at most 30 distinct text sends;
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

The native Telegram source implements the existing provider protocol for exact
group IDs. It records selected text messages and sender identity, and sends only
to the bound group with durable uncertain/accepted receipts. Bot messages and
anonymous-admin posts are excluded by intake. Unselected owner group text remains
private discovery; other unselected group messages cannot launch work. Source
registration enables discovery, never reply permission. Voice and attachments are
not handled by this group adapter. WhatsApp continues using its existing adapter;
group and ongoing watch support requires the companion provider update. Older
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

A core stdio MCP broker exposes `context`, `send`, `note`, `report`, and `complete`.
The native client also lists resource helpers, but the broker serves no resources.
Only these five tools have native approval bypass configured: the core rechecks
the grant on each call. Broker requests cross host/relay through private atomic
control files; only the relay dispatches provider writes. Model tool arguments
never choose a recipient, account, control path, shell command, or permission.
The native harness and broker are trusted processes; this is model-tool
containment, not isolation from a malicious native executable or local host user.
Native configuration reference: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

Task notes live under protected `control/tasks/`, separate from the owner mind.
Reports go to the owner's Telegram outbox, visibly labelled as task reports;
they are not inserted as owner instructions or trusted memory. The owner mind
keeps its existing `inbox/` and `work/` organization. No database or general memory
index is introduced.

## Provider protocol

A registered Unix event source advertises `taskProtocol: "message-v1"` and a
stable string `accountId` in `events-head`. The core calls `task-watch` with that
account, exact `conversationId`, and expiry to request bounded capture attention.
The existing events/events-check protocol supplies incoming messages. This
subscription grants attention only; execution still requires the core grant.

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
owner runs remain readable. Package state schema stays 1, but rollback suspends
task processing until a task-aware version returns; rollback does not replay
messages or erase task receipts. Update host and relay together. A missing or
outdated host fails task launch closed.

The installing host user remains trusted and can modify local control state.
Owner runs can use the plugin manager and Docker administration; content read
inside owner work still depends on native protections and agent judgment. This
is not a public multi-tenant execution service. Family delegation, payments,
enterprise reviewer agents, arbitrary file sharing, and other restricted native
executors are deferred.

Verify with `pnpm verify`, Docker test/runtime targets and smoke fixtures.
`EZ_TEST_NATIVE_TASKS=1 pnpm exec tsx --test test/task-native.test.ts` checks the
actual pinned native tool inventory and executes a synthetic model/broker/provider
conversation without real credentials or external sends. Real Telegram-owner to
WhatsApp-correspondent acceptance remains separate live QA requiring an
authorized account/contact.

For plain-language intent, onboarding defaults and source setup see
[selective monitoring](../selective-monitoring.md).
