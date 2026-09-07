# Agent-owned software upgrades

Available in the beta.3 development candidate; VM acceptance is pending. npm
publication is not required to test this feature. Stable releases are the default
automatic channel. The existing owner may select beta or manual policy per target.
The main target and installed plugins version independently.

The agent owns release review, policy decisions and communication. The host
supervisor owns interruption-safe replacement. There is one host service per
agent, not a second agent or an additional updater daemon. Its replaceable child
runs the normal CLI transport. It checks npm every six hours while running and
queues an owner-bound maintenance turn only when an automatic channel changes.
No owner means no maintenance executor. Normal user work and maintenance share
one serial queue. Checks use the installed scoped npm identity; failures are
visible in `updates check` and private `tools/updates/available.json`.

## Installation and scope

Use normal setup and initialize the registry with this deployment's
`host-executor.json`. This binds `ez updates`, the active package root and the
Software updates guidance in TOOLS.md. Start `ezenciel-agents-host` using the
normal OS service template. The host service must use the existing user's Node,
pnpm and Docker access. Never put tokens in its environment. Keep the original
package directory: its small bootstrap remains the service entry point and loads
the active supervisor on each restart. It must not be moved or garbage-collected.

Older beta installations have no supervisor or release contract. Their initial
migration to this candidate is installer-owned: stop the old host/relay, install
and build this candidate, retain the deployment, and use its tools entry point:

```sh
node /absolute/candidate/package/bin/ezenciel-agents-tools.mjs enable-updates \
  --home /absolute/deployment/tools \
  --host-config /absolute/deployment/host-executor.json
```

Point the host service and relay Compose source/image at the candidate, then
restart and verify. Do not recreate the agent or its registry. Subsequent
compatible upgrades are agent-owned. Noncanonical/multi-agent host configuration
files require migration to one canonical deployment per service first.

## Agent interface

```sh
ez updates check
ez updates policy main                 # defaults: automatic, stable
ez updates policy whatsapp beta        # only under owner authorization
ez updates policy main manual          # disable unattended upgrades
ez updates prepare main --version 0.1.0-beta.4
# Or a local candidate, independently of npm:
ez updates prepare whatsapp --file /absolute/candidates/whatsapp.tgz
ez updates apply <returned-job-id>       # explicit owner-requested candidate
# Automatic registry release within saved policy:
ez updates apply <returned-job-id> --automatic
ez updates status
```

Examples are candidate version placeholders, not a claim of published versions.
`prepare` downloads from npm or reads a local tarball, checks integrity, rejects
unsafe archive entries, and records identity/version/hash. It does not stop a
service. Local candidates never qualify for `--automatic`; an explicit request
is required. Stable automation excludes prereleases, major changes and 0.x minor
changes. Beta policy permits compatible prereleases. Downgrades are rejected;
rollback is a recovery operation for the previous installation only.

`apply` records one durable queued job. **The agent must finish its turn after
queuing it.** It must not wait for completion in that same turn. The supervisor
pauses new run admission, drains already-started work, then consumes the job.
One job at a time; an unresolved recovery blocks new upgrades. The agent processes
multiple requested packages over successive maintenance turns.

The exact archive is reverified and re-extracted before execution; editing a
prepared tree cannot substitute code. Main dependencies install with the frozen
lock and lifecycle scripts disabled. Images build before services stop. The host
pins the previous relay image, saves a private backup and replaces the runtime
and host child. Plugin replacements use the registry lock and canonical project
and volumes. Running plugins restart with a health check; stopped plugins stay
stopped and report `runtimeVerified:false`. Upgrading never links an account.

## Recovery and limits

Job receipts live privately under `tools/updates/<job-id>/`. `status` omits private
rollback configuration. States are prepared, queued, applying, completed, failed,
rolled-back and recovery-required. A service restart recovers an interrupted
applying job before resuming normal work. A failed build leaves the old runtime
running. Failed activation restores the previous code/configuration and checks it.
If recovery itself fails, inspect and fix the reported infrastructure problem,
then use `ez updates recover <job-id>` and finish the turn. This retries only the
saved code/configuration recovery, not provider operations.
Completion or failure wakes the agent to inspect the receipt and report naturally.

Backups contain credentials and must stay private. Main backups cover the
canonical mind/control and deployment files. Plugins back up existing named
volumes while their services are stopped, using the previous image's `tar` and
read-only volume mounts; archive output is written by the host with mode 0600.
No backup deletes live data or revokes credentials. Retain old package roots and
images until QA and any recovery window are complete; there is no automatic GC.

The updater accepts only matching state-schema and protocol contracts and an
unchanged deployment layout. Changes to privileges, services, volumes or Compose
configuration fail before replacement, even for an explicit candidate. These
need a separately reviewed migration, not an override flag. Release authors must
truthfully declare schema compatibility. Code rollback **does not rewind private
state**, provider cursors or operation receipts; uncertain actions are never
replayed. Docker health is not proof of live provider identity or delivery.

## Contributor acceptance

Every main/plugin release must declare `package.json.ezRelease`:

```json
{"protocol":1,"kind":"plugin","stateSchema":1,"mainProtocol":1}
```

Use `kind: "main"` for the main package. `stateSchema` is the compatibility epoch
for persisted state: keep it only when the previous release can safely read state
written by the new one. Increment it for incompatible writes; this updater will
refuse that migration. `mainProtocol` identifies the supported updater/registry
contract, currently 1. Plugin package and manifest versions must match.

Verify upgrade from the previous supported artifact, retained identity/state,
failed-health rollback, and rejection of incompatible candidates. Main runtime
changes also need supervisor restart and requesting-process-exit tests. Run
`pnpm verify`, `npm run release:check`, packed Docker builds and
`node docker/upgrade-smoke.mjs` with a local `EZ_WHATSAPP_SOURCE` containing the
WhatsApp fixture. The smoke uses synthetic transport only. VM installation,
agent-led upgrades, restart and real account acceptance remain separate QA gates.
