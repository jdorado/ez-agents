# External engine: scoped MCP interface

An external engine (such as a dot) supplies reasoning while Ez supplies its
explicit environment, approved context and deterministic installed tools.
Calling this interface never starts Codex, OpenCode, a relay, or a model session.
It does not take over a scheduled agent or add a workflow/persistence controller.

The interface is stdio MCP: `environment_bootstrap`, then explicitly
allowed parameterless read tools, with an optional separately granted isolated
smoke note. Bootstrap returns only the named environment,
approved Markdown bytes and their hashes, allowed tool names and state/ownership
metadata. The engine resumes by bootstrapping again and comparing those hashes;
no native chat, session, broker account or control ledger is implicitly exported.
Library/Git remains the context owner. Retrieval/search beyond bootstrap requires
a separately reviewed plugin read alias, never arbitrary filesystem access.

## Two independent approval gates

A plugin command may declare `externalRead: true` only with explicit exposure
`changesRecords: false` and `requiresReview: false`. Its reviewed executable and
fixed manifest arguments must be read-only and return bounded, sanitized JSON.
The declaration grants no access. Do not mark a broad Strategy/admin alias as
externalRead; add a dedicated product-owned read alias. Product-specific data
validation and sanitization remain in that plugin, not core.

An operator separately writes a private binding file outside both the tools home
and agent workspace, owned by the service UID and not writable by group/others:

```json
{
  "schemaVersion": 1,
  "id": "stocks",
  "toolsHome": "/absolute/stocks/tools",
  "workspace": "/absolute/stocks/mind",
  "contextPaths": ["AGENTS.md"],
  "tools": []
}
```

Missing `contextPaths` and `tools` mean empty exposure. No registry aliases are
automatically published. A tool allowlist entry is:

```json
{
  "name": "stocks_health",
  "command": "stocks-health-read",
  "revision": "sha256:REVIEWED_64_HEX_DIGEST",
  "description": "Read sanitized Stocks backend health; no refresh."
}
```

Discovery and invocation check the exact installed revision and manifest gate.
Read alias schemas are empty objects with `additionalProperties: false`; arguments,
stdin, caller-selected command vectors, paths and environment switching are
rejected. Changing the grant requires restarting the adapter; the old process
fails closed. No credential belongs in this file or in tool inputs.

Bootstrap reads at most eight explicitly listed Markdown files, 32 KiB each and
64 KiB total. Hidden/private/control paths, symlinks, escape paths and detected
credential-shaped content are denied. Detection is a defense in depth heuristic,
not a guarantee that arbitrary documents contain no secrets: the operator must
approve exportable context, using a curated document when originals mix private
and shareable data. No automatic copying or redaction changes canonical context.

## Ownership, errors and receipts

Tools use the existing bound plugin broker execution primitive and Docker plugin
transport with the fixed manifest arguments, timeout and output limits. Each
bootstrap/invocation takes the existing workspace lease, rejects competing native
work and releases it afterward. No synthetic native run or owner session is
created. This is per-call exclusion, not a persistent external writer lease or
an atomic whole-reasoning snapshot. Native reasoning may proceed between calls.

Successful calls return structured data and a receipt with environment, binding
hash, timestamps and plugin revision when relevant. Receipts are returned to the
caller, not a new durable audit database. Plugin errors and stderr are suppressed
at the MCP boundary. Existing plugin/Library state is preserved, but this PR
provides no general persistence write, external run lease, schedule change, messaging,
trade, model sampling or cancellation tool. Those require separate reviewed
authority and existing storage/ownership contracts before enabling a general writer.

## Optional isolated persistence smoke

An operator may separately grant a single new smoke artifact through the existing
Library CLI and its storage/operation receipts. Add only:

```json
"smokeNote": {
  "library": "default",
  "revision": "sha256:REVIEWED_LIBRARY_64_HEX_DIGEST"
}
```

This publishes `smoke_note_write` (`requestId` UUID, `text` up to 1,024 UTF-8
bytes) and `smoke_note_read` (`requestId` UUID). The path is fixed:
`notes/ez-external-smoke/<environment-id>.md`. No caller path, CLI arguments,
library choice or expected revision is accepted. The adapter checks the exact
pinned Library manifest/deployment contract, invokes only `put --expected new`,
`operation`, and `get --raw` through the broker, and takes the existing workspace
lease. Library owns its writer lock, path/symlink checks, atomic saves, durable
operation receipts and existing Git/provider sync policy; core writes no file
or new persistence store directly.

Existing bytes are never replaced, even with another requestId. A matching retry
uses Library's idempotent operation key; changed content or stale bytes fail.
Read requires the scoped operation receipt to prove this exact path, create-only
precondition, bounded size and hash, then verifies the returned bytes against it.
It cannot read a pre-existing arbitrary file or search the Library. After a failed
write, the outcome is unconfirmed: reconcile with `smoke_note_read` and the same
requestId before considering a retry. There is no automatic write retry or
cleanup/delete tool. Retain the dedicated test note or remove it later through
the existing owner-authorized Library workflow.

## Post-review smoke procedure (not activated by this PR)

1. Review and stage the exact core PR candidate; do not release or replace production.
2. Install a reviewed dedicated safe-read plugin alias in an isolated test environment.
3. Approve its exact environment binding and context export, then start:
   `ezenciel-agents-external-engine --binding /absolute/operator/grant.json`.
4. Verify MCP initialization, discovery, bootstrap and one health/status read;
   reject unknown tools, unexpected arguments, changed pins and busy leases.
   For an approved persistence smoke, write the isolated note, reconnect, read it
   by its requestId and compare the text/hash. Reject replacement and path inputs.
5. For a remote dot, separately approve authenticated transport and credential
   setup. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
   can run outbound on the existing VM and forward this stdio command, with no
   public listener. It needs an approved tunnel/workspace association and private
   runtime key. The local MCP process itself is not a public authenticated service.
6. Call the discovered tool directly from the dot and verify the sanitized result.
   A fixture/local smoke alone is not end-to-end remote acceptance.

The adapter has no network listener or credentials and changes no firewall,
VPN, installed registry, owner pairing, schedule or native engine selection.
One binding per process preserves environment isolation; a deployment may start
separate approved instances for other environments without widening any grant.
