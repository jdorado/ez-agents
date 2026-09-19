# Build, install, and publish an Ez plugin

This is the shareable guide for open-source Ez plugin authors. It covers the
smallest path from a plugin checkout to a working private installation, and
the separate path for publishing and listing a public product.

The detailed documents linked below remain the normative references for release
and security edge cases. This page is the front door.

## The important distinction

An Ez plugin can be useful before it is published. These are separate states:

| State | What it means | What is required |
| --- | --- | --- |
| Local-only | You install your own reviewed checkout or tarball on your agent. | A valid package, an inspected content hash, and real executor verification. No npm publication or catalog entry. |
| Catalog-listed | Ez publicly records the plugin as a product capability. | A catalog PR with the canonical repository, package identity, capability, and release links. Registration does not prove that a release exists. |
| Released | Other users can install an immutable package from npm/GitHub. | Release checks, exact artifact/hash readback, a tagged GitHub release, registry publication, and clean-host verification. |

Do not treat a catalog entry, a GitHub workflow, or a package name as proof that
an artifact was published. Read back the actual npm and GitHub release records.

## 1. Define the plugin boundary

Use a plugin when the capability needs provider or domain authentication,
deterministic validation, private state, or provider receipts. The native AI
engine owns inference, sessions, context, reasoning, tool choice, and
continuation. Ez core owns authorization, transport, scheduling, cancellation,
session binding, and delivery receipts.

Keep provider behavior out of the relay and do not add another agent runner,
model router, conversation engine, prompt-history store, or competing queue.
General plugins live in the Ez plugin repositories; a product-specific plugin
stays with the product that owns its canonical data and policy. See the
[plugin architecture](../../planning/docs/architecture-plugins.md).

## 2. Build the smallest valid package

At minimum, provide:

- `package.json` with a unique scoped package name, SemVer version, repository
  URLs, `files` allowlist, and supported Node/package-manager versions.
- A frozen lockfile, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.
- `README.md` explaining purpose, requirements, exact install/start/onboarding
  commands, one working read example, identity/account binding, limitations,
  and troubleshooting.
- `Dockerfile` and `.dockerignore` when the plugin has a managed service.
- `ez-plugin.json` with the stable plugin id, matching version, commands, and
  skill paths. Declare command exposure for external content, external sends,
  record changes, and requested review.
- `ez-deployment.json` when the plugin has managed services, volumes,
  healthchecks, exports, or deployment dependencies.
- A skill such as `skills/<plugin>/SKILL.md` covering required inputs, private
  credential handling, external handoffs, resumption/recovery, and readiness
  evidence.
- Offline contract/negative tests, `--help`, a read-only doctor, bounded
  machine-readable commands, stable exit codes, and readback for writes.

The manager snapshots the package according to `package.json.files` plus the
required manifests and Docker inputs. Keep one canonical checkout; do not keep
permanent packaged copies or a second registry. See the full
[plugin contribution requirements](plugin-contributions.md) and the
[plugin manager contract](plugins.md#deployment-descriptors).

A typical package layout is:

```text
plugin/
├── bin/                    # executable entry points
├── skills/<plugin>/SKILL.md
├── src/
├── test/
├── Dockerfile              # if a service is managed
├── ez-plugin.json
├── ez-deployment.json      # if a service is managed
├── package.json
├── pnpm-lock.yaml
├── README.md
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

## 3. Test and install it before publishing

From the plugin checkout, run the package's documented checks. The standard
baseline is:

```sh
pnpm install --frozen-lockfile
pnpm verify
npm run release:check
git diff --check
```

Run the plugin's Docker/manager smoke test when it has a managed service.
Verify installation, start/stop, the registered command, restart persistence,
and non-destructive uninstall using synthetic data. Then run one authorized,
supported operation through the actual bound executor and verify its canonical
result or provider receipt.

### Install from local source or an unpublished tarball

Publication is not required. Inspect the exact source first:

```sh
ez plugins inspect <id> --source /absolute/plugin
```

Use the returned revision for either a one-off install:

```sh
ez plugins install <id> --source /absolute/plugin --revision sha256:<inspected-hash>
ez plugins start <id>
```

Or save the reviewed source in the agent's local catalog, then install it by
the catalog entry:

```sh
ez plugins catalog-add <id> --source /absolute/plugin --revision sha256:<inspected-hash>
ez plugins install <id>
ez plugins start <id>
```

After startup, verify the installed command from the actual executor:

```sh
ez plugins status <id>
ez tools list
ez <command> doctor --json
```

Use the plugin's real supported operation as the acceptance test. Health,
registration, or a successful `--help` command alone is not completion. A
changed source must be inspected again; never install a stale catalog hash.

## 4. Prepare a public release

Use an isolated release worktree and reviewed PR. Then:

1. Bump the package and plugin manifest to the same new SemVer version. Add
   changelog and migration notes for breaking CLI or state changes.
2. Run frozen dependency installation, package tests, release checks, Docker
   checks, `git diff --check`, dependency/license review, and the actual manager
   smoke test.
3. Create the candidate with `npm pack --ignore-scripts`. Inspect its file list,
   compute and record its SHA-256, extract it into a fresh directory, reinstall
   from the artifact, and repeat the CLI/runtime checks there.
4. For a first release or onboarding change, install that exact candidate on a
   disposable clean host and verify the real executor, restart/boot behavior,
   account binding, and first supported operation.
5. With explicit release authorization, tag the reviewed source, publish the
   exact tested artifact, create the matching GitHub prerelease/release, and
   read back npm metadata, the downloaded tarball hash, release assets, and
   source/tag identity.
6. Install the published version on a clean host and repeat the relevant
   verification before calling the release complete.

For the complete release checklist, use [Releasing](releasing.md). For
unattended beta publication, use [Verified beta publication](trusted-publishing.md);
it defines the immutable GitHub asset, sanitized receipt, OIDC trust, dispatch,
and failure-reconciliation rules. Do not put npm tokens in CI or publish merely
to test authentication.

## 5. List it as a public product

Catalog registration is a discovery and product step, not installation
authority. Open a PR updating [Available plugins](plugin-catalog.md) with:

- the product name and one concrete capability description;
- the canonical public source repository;
- the exact npm package identity; and
- canonical npm and GitHub release links.

Only advertise a version as installable after verifying that it exists in the
registry and in the matching GitHub release. A public catalog entry may exist
while its first release is still pending; label that state clearly and do not
present it as an installable version. Keep local/private plugins out of the
public catalog; they can still be installed by reviewed source and an inspected
hash.

## The short checklist

### Own agent / unpublished

- [ ] Package, manifests, skill, README, license/notices, and tests exist.
- [ ] `pnpm verify`, release checks, and the manager/Docker smoke pass.
- [ ] Source or tarball is inspected and installed with its returned hash.
- [ ] The actual bound executor performs a real supported operation.

### Public product

- [ ] The exact candidate is packed, inspected, hashed, and clean-host tested.
- [ ] Release authorization, tag, GitHub asset, npm publication, and readback
      all refer to the same source and bytes.
- [ ] A clean installation of the published version is verified.
- [ ] The public catalog is updated only with verified repository/package/release
      records.

For contribution, security, and removal details, follow the links above and the
plugin's own `CONTRIBUTING.md`, `SECURITY.md`, and README.

