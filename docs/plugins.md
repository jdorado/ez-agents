# Native plugin manager

Built-in host-side CLI registry and Docker lifecycle manager in the main Ez package. Native Node 22+
only; no relay imports, provider libraries, model loops or global `ez` install.
The existing host executor uses an agent-bound launcher. This is the narrow host
administrative tool, not another executable provider plugin or Docker daemon.

## Initial agent installation

The installing agent provisions this once. Use explicit absolute paths:

```sh
node /absolute/ezenciel_agents/bin/ezenciel-agents-tools.mjs init \
  --home /private/agent/tools --workspace /private/agent/mind \
  --host-config /private/agent/host-executor.json
```

Without `--catalog`, init loads an empty packaged catalog. Keep it empty for
initial main onboarding; no sibling repository, broker or provider account is
needed. Finish owner pairing and verify an actual Telegram agent reply first.
Init creates a private registry and `tools/bin/ez`, adds a
TOOLS.md discovery entry, and binds the matching host executor to that bin
folder. Native binaries are linked through; an existing `ez` collision fails.
Run before starting the host executor. For an already running installation,
place a symlink to the returned launcher in that agent's existing private bin
directory and set that binding's `toolsHome` to the absolute registry directory.
Restart the host executor between jobs so it loads the binding. Init with
`--host-config` sets `toolsHome` automatically. Never overwrite global ez.

The host validates that `toolsHome` belongs to the bound workspace. For Codex,
it adds that registry to writable roots and enables network access for Docker.
Docker Buildx metadata uses `toolsHome/buildx` through `BUILDX_CONFIG`, so builds
do not need write access to the host's shared Docker configuration.
The GUI adapter also sets `sandboxPolicy.networkAccess` when `toolsHome` is
bound, on both new and resumed turns; omitting it blocks Docker socket access.
Verify status and a harmless plugin command inside the actual executor turn.
Host-shell success alone does not establish worker access.
Job requests cannot override this host binding. Filesystem access remains
`workspace-write`; other agents' directories are not added. Docker access is
host administration under the existing trusted-host model, not OS isolation.

## Installation completion contract

For initial Ez onboarding, plugin requests happen in the working Telegram
conversation after the main owner exchange is verified. The original host CLI
must not perform plugin setup instead. The installed agent inspects the supplied
tarball/checksum, extracts it inside its writable tools directory, and uses
`ez plugins inspect <id> --source <path>` and `catalog-add` with the returned hash.
It then handles install/start and QR onboarding in that same conversation. A
plugin tarball supplied with the main artifact is deferred input, not permission
to skip the main-first handoff.

When the user says install or set up a plugin, the agent owns completion through
usable capability, unless the user explicitly requests package files only.
Inspect the package, read its skill, install, start, complete provider onboarding,
and verify the intended identity and a real supported operation. Reuse existing
working connections. Registration, container health and setup artifacts alone
are not completion. Low-level install/start/connect commands remain separate;
the agent invokes them within the original request without repeated permission.

Use the agent's known identity and authorized context. Choose routine technical
labels, generate credentials into plugin-owned private storage, and select
permissions appropriate to the requested capability. Ask only for genuinely
missing inputs or actions requiring the human or external provider, such as a QR
scan, OAuth consent, verification code, or access to an existing account. Do all
technical setup yourself, including administrative setup for the owner. When an
API key is required, ask the owner to provide it with the exact provider link and
location; handle storage privately and never echo it. Do not assume a separate
administrator exists or hand the owner internal configuration terminology. Do all
independent preparation first. Deliver the actual image or exact authorization
link privately with one concrete action; never hand the user CLI setup chores.
Keep setup pending, resume after that step, and verify the provider result.
Reuse the original installation authority; do not invent identity or expand it
to purchases, unrelated accounts, outbound messages or destructive changes.

Each plugin skill must explain required inputs, which can come from agent
context or be generated, private credential handling, external handoffs,
resumption/recovery and evidence of readiness. Record non-secret connection
and maintenance details for future turns. The generic manager remains plumbing;
provider setup decisions and conversation belong to the agent.

## From the agent conversation

```sh
ez plugins available
ez plugins inspect whatsapp
ez plugins install whatsapp
ez plugins start whatsapp
ez tools list
ez whatsapp doctor --json
```

The agent reads the installed WhatsApp skill and guides its QR onboarding. Fetch
the declared QR into the bound workspace with:

```sh
ez plugins export whatsapp qr --output /private/agent/mind/work/pairing.png
```

The output file must not exist and its parent must already exist. Deliver it
through the agent's existing messaging tool, then delete that temporary private
image. Never publish the profile. `doctor` must confirm the intended identity.
The manager does not send messages, link accounts, or implement onboarding flows.

Other commands: `plugins list`, `status <id>`, `logs <id>` (last 100 lines),
`stop <id>`, `uninstall <id>`. Uninstall stops/removes only that Compose deployment
and unregisters its aliases; it retains named data volumes and reviewed source
snapshots. Reinstallation reuses that data. Plain install does not replace a different release. Use `ez updates` for
compatible upgrades under saved policy; see [upgrades](upgrades.md). Manual
uninstall/reinstall remains available but does not promise schema rollback.

For another reviewed local package, inspect with `plugins inspect <id> --source
/absolute/source`, then install with that source and the returned `--revision
sha256:...`. Changed contents fail. To make a reviewed package discoverable without installing,
use `ez plugins catalog-add <id> --source /absolute/source --revision sha256:...`.
Inspection is read-only: its returned revision does not replace the saved catalog
pin. After reviewing changed source, pass the returned `--source` and `--revision`
to `catalog-add` to update that entry, then install. Alternatively, pass them
directly to install for that invocation. Do not retry a plain install against a
stale catalog pin. A mismatch after passing the inspected revision means the
source changed again; finish edits and inspect the stable source before pinning.
Catalog updates preserve other entries. No remote package marketplace or arbitrary
package-manager proxy is implemented.

Installation snapshots only `package.json.files` plus required manifests and
Docker inputs, validates the descriptor, builds/pulls, then atomically registers.
It does not start services. Repeated installs report existing state; interrupted
builds can reuse a matching snapshot. Unknown fields, symlinks, reserved aliases
and duplicate aliases fail. An interrupted manager leaves `registry.lock` with
its PID: verify that process is gone before explicitly removing that one lock.
Never remove an active lock or delete provider data to repair installation.

## Exposure declarations

Each command in `ez-plugin.json` can include an optional `exposure` object:

```json
{
  "executable": "bin/client.mjs",
  "args": [],
  "exposure": {
    "receivesExternalContent": true,
    "sendsExternally": true,
    "changesRecords": true,
    "requiresReview": true
  }
}
```

These four fields are booleans. Unknown fields and invalid values are rejected.
Each omitted field defaults to true; legacy manifests remain installable with
conservative exposure. Declaration changes change the inspected content hash.
Use `ez plugins inspect <id>` before installation and `ez tools exposure` afterward
to see normalized declarations. Existing `ez tools list` output stays unchanged.

Describe capabilities, not a trust rank: CRM notes can contain customer-authored
text, while a channel can also modify records. `requiresReview` requests added
attention during setup/use; it does not enable an automated reviewer. Declaring
false never grants permissions, disables core checks or certifies a plugin safe.
The core owns authority; plugins own provider transport/authentication/receipts.

Current adapters are trusted-owner executors. Registered external events are
recorded as blocked and do not launch those adapters. These declarations do not
enable autonomous external conversations or scoped task execution. See
[authority boundaries](architecture/authority-boundaries.md).

## Deployment descriptors

`ez-plugin.json` retains its v1 executable/args/skills contract.
`ez-deployment.json` is a separate strict descriptor:

- `schemaVersion: 1`.
- `services`: named services, each with exactly one `buildTarget` (from the
  snapshotted Dockerfile) or digest-pinned `image`; a nonempty `healthcheck` argv;
  optional literal `command`, `volumes` mapping named private volumes to container
  paths, and `workspace: true` for the owning mind mounted read-only.
- `commands`: the same aliases as the plugin manifest; each names its `service`,
  executable `argv` and optional literal `suffix`. Dispatch is argv + manifest
  args + user args + suffix. No parsing or provider parameter translation.
- Optional `exports`: named artifacts with an exact service and file path.
  Review these paths: declaring a secret as an export would expose it.

V1 remains supported. V2 adds declared generated `secrets`, service `environment`
(literal strings or declared secret references with literal prefix/suffix),
`dependsOn` health dependencies, non-root `user` and bounded `memoryMiB`.
Cycles, unknown dependencies and host environment interpolation are rejected.
Secrets persist privately across reinstall and are never included in registry
responses. Twenty provides a complete v2 backend example.

Compose JSON is generated, not accepted from untrusted arbitrary Compose input.
No ports, host network, privileged services, host env inheritance, arbitrary bind mounts,
Docker socket or raw Compose args can be supplied. Project names include a hash
of the canonical registry path; networks and volumes inherit that namespace.
Images use release-specific names. All containers drop capabilities and run as
UID 1000 by default; v2 can declare another non-root UID:GID. Plugins sharing a profile remain in the same owning deployment.

Commands run in one-shot client containers against their own service's volumes;
stdin, stdout, stderr, literal arguments and exit codes are preserved. SIGINT/
SIGTERM cancel the Docker call and remove its unique client container. The manager
never retries a provider operation. Service startup/restart is explicit; commands
never implicitly start a stopped provider service. Plugin data does not enter the
relay. The manager sends only a whitelist of Docker client environment variables.

## Verification

`npm run verify` runs offline negative/contract tests. Explicit Docker integration:
`node docker/plugin-smoke.mjs`. It builds the actual WhatsApp package with the
synthetic transport in an isolated snapshot and tests installation, start,
registered CLI, literal file paths, idempotency, restart persistence and
non-destructive uninstall. No live account or recipient is used.

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.
