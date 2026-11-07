# Releasing

Use the same checks for maintainer and external changes. Each repository versions
independently with SemVer: patch for compatible fixes, minor for new capabilities;
before 1.0, breaking CLI/state changes require a minor bump and migration notes,
except for packages numbered by release counter (see [Release numbering](#release-numbering)).
No automatic dependency updates or credentials in pull-request CI. The agent
operates this process under the authorization rules in CONTRIBUTING.md; a
separate release bot is not required.

1. In an isolated release worktree/PR, finalize package version and CHANGELOG.md;
   update plugin manifest version when present. After lockfile changes, copy
   `pnpm-lock.yaml` to `docker/pnpm-lock.yaml` (npm omits the root lockfile; CI
   checks this shipping copy is identical). Never overwrite a published version.
2. Run `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm run release:check`,
   `git diff --check`. Review `npm audit --omit=dev` and dependency licenses.
   Record accepted risks with a reason; never run an unreviewed audit fix.
3. Build both Docker targets from a clean checkout:
   `docker build --target test -t ez-release-tests .` and
   `docker build --target runtime -t ez-release-runtime .`.
   Docker CI uses a fixed interactive Codex version and exercises the restricted
   runner with the separate `TASK_CODEX_VERSION` pin. Managed installs and
   upgrades resolve the interactive Codex version through the normal installer.
   Main relay: `EZ_RELAY_IMAGE=ez-release-runtime node docker/smoke.mjs`.
   Isolated executor: `EZ_RELAY_IMAGE=ez-release-runtime node docker/isolated-executor-smoke.mjs`.
   The WhatsApp Compose overlay has no separate relay image; verify its
   provider integration with the synthetic plugin smoke in `docs/plugins.md`.
4. Create an artifact with `npm pack --ignore-scripts`. Inspect its file list,
   hash it, extract into a fresh directory, copy `docker/pnpm-lock.yaml` to
   `pnpm-lock.yaml`, and run `pnpm install --frozen-lockfile`.
   Repeat CLI help and runtime build there. GitHub publication includes the Git
   tree/history; npm's files list does not sanitize Git history. Review both.
5. For initial release or onboarding changes, install the exact candidate on a
   disposable clean host. Follow setup without sibling checkouts or personal
   state. Verify owner pairing, real reply, service restart/boot and the first
   plugin through the actual executor. A fixture proves plumbing only. Use an
   authorized test account, record receipts privately, publish only a sanitized
   result. Document any unsupported platform/executor explicitly.
6. Confirm repository owner/URLs, package-name availability and publisher access;
   fill package.json repository, homepage and bugs with the actual public URLs.
   Enable GitHub private vulnerability reporting; verify the route. Protect main
   with CI and independent PR review. Maintainers use the same process.
7. Record independent review and green CI for the final release PR. The
   maintainer's release request supplies authorization: do not ask for a second
   approval. Record the prepared commit, tarball SHA-256, third-party obligations
   and known limits. If release is outside the request, report readiness without
   publishing. For an authorized release, merge the release PR and
   verify its tree matches the reviewed source before tagging `v<version>` and
   publishing that tarball:
   `npm publish /absolute/candidate.tgz --access public --tag latest --registry https://registry.npmjs.org/`
   for approved beta releases as well: `latest` is the default distribution tag,
   not a claim of stability for a pre-1.0 release.
   For unattended beta publication use the [shared trusted publisher](trusted-publishing.md)
   and its exact-artifact staging/readback contract. One dispatch validates, creates
   a missing `v<version>` tag at the verified source, publishes once and waits for
   npm to list the version, then adds `SHA256SUMS` and the publication receipt to the
   staged draft and publishes it as a prerelease that is not marked latest. Initial package publication
   requires authenticated npm with 2FA before trust can be enrolled; never paste
   tokens into CI or docs.
8. Create the GitHub release from CHANGELOG.md with the artifact attached (for a
   shared-publisher beta, the draft it publishes, which also gains the checksum and
   publication receipt), and install the registry version on a clean host. Verify metadata and the same
   onboarding path before posting launch copy. Stop rollout on failure; publish
   a new patch or deprecate the bad version, never silently replace an artifact.

Container images are built locally in this initial release. Public image
publication is a separate decision and requires the corresponding source and
third-party notices. Back up private state before upgrades. Uninstall is not
credential revocation; do not delete volumes as a routine rollback.

## Beta channel

Publish release versions (`0.N.0`, see [Release numbering](#release-numbering);
legacy releases are `0.1.0-beta.N`), GitHub's prerelease flag and npm's
`--tag latest` so default installs and the package page advance automatically.
The GitHub release stays flagged prerelease while the package is below 1.0.
A legacy `-beta.N` version is also a SemVer prerelease, so stable-only update
policies exclude it; a `0.N.0` release carries no prerelease tag, so a stable-only
policy follows it. The legacy npm beta tag is no longer advanced. For this first beta the maintainer
explicitly deferred real account/reboot acceptance. Keep that limitation in the
README and release notes. Source/tarball publication is permitted after the
automated gates; deferred live checks remain required for stable release.
GitHub repositories use `jdorado`; npm packages use `jc_stack`. Verify
`npm whoami --registry https://registry.npmjs.org/` returns `jc_stack` before
interactive publication. OIDC publication instead requires package-owner trust
enrollment for the exact caller workflow; `whoami` is not its publication gate. Never infer npm scope ownership from a GitHub login. After publishing,
read back `npm view @jc_stack/ez-agents@0.71.0 name version dist-tags --json`
(using the release being published), download it with `npm pack`, and verify its
contents/checksum against the reviewed artifact. Keep the npm artifact and
GitHub tag on the same reviewed commit. Do not create a new token to bypass 2FA.

Source-checkout images for a deployment are RC builds of the unreleased commit:
`ezenciel-agents-install build --label 0.N.0-rc.M` (increasing `.rc.M`; legacy
`X.Y.Z-beta.N.rc.M` is still accepted) from the clean reviewed commit after the PR is open. The label and commit SHA are
baked into the image; `/status` shows the RC tag first. Never install an
unlabeled source build or reuse an RC label for different contents.

## Release numbering

A release is `0.N.0`, where N is the next integer after the package's last
published counter: each package counts its own releases (core after
`0.1.0-beta.70` publishes `0.71.0`; a plugin after `0.1.0-beta.19` publishes
`0.20.0`). A QA candidate is `0.N.0-rc.M` from the exact PR commit, local/private
only, never published or tagged; the next RC is the last RC plus one. Under
standard SemVer `0.N.0-rc.M` sorts below `0.N.0`, so the updater needs no special
rule for it, and a candidate can be staged from a source already numbered `0.N.0`.

The legacy `0.1.0-beta.N`, `.rc.M`, `.qa.M` and `.compat.M` versions stay valid:
every installed or published one keeps working, and the updater, publisher, QA
staging and RC image labels accept the new scheme in addition to them. Any
`0.N.0` is above every `0.1.0-beta.*`, and the legacy rule (a private RC or QA
build may graduate to its matching `beta.N` or newer) is unchanged for legacy
versions. Because every release now bumps the minor version, the automatic update
policy treats a move between `0.N.0` releases, or between one and a legacy
`0.1.0-beta.*`, as compatible; other pre-1.0 packages keep the same-minor rule.
A state-breaking release is still refused by the `ezRelease.stateSchema` contract
rather than signalled by the version.

Before choosing N, read the installed and staged versions: a release below an
installed RC's N is refused by that agent's updater.

**Bootstrap.** Updaters in `0.1.0-beta.69` and older do not accept the scheme
automatically: their compatibility rule requires the same minor version before 1.0,
so an automatic update to `0.N.0` fails (the supervisor logs `Automatic update of
main failed`), while an explicit `updates prepare` and `apply` works. The first
release containing the counter scheme is therefore published as `0.1.0-beta.70`,
and `0.71.0` is the first `0.N.0`. Candidates for that bootstrap release use the
legacy form `0.1.0-beta.70.rc.M` (`0.70.0-rc.M` would sort above `0.1.0-beta.70`
and be refused by an agent that installed it); `0.N.0-rc.M` starts with the
`0.71.0` cycle. Publish `0.71.0` only after the agents have had time to take
beta.70: an agent still on beta.69 retries the failed automatic update every few
hours and leaves a prepared job directory per attempt.

Plugins should adopt `0.N.0` only after their agents run core `0.1.0-beta.70` or
newer; an agent still on an older core needs an explicit update for each. A
plugin's `publish-beta.yml` must also pin a core commit containing this change
(see [Shared publisher updates](#shared-publisher-updates)); an older shared
publisher rejects `0.N.0` before publishing anything.

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.

Automatic main upgrades are gated on deployment compatibility: the candidate's
`compose.yaml` and `compose.whatsapp.yaml` must match the release the agent
already runs, or that installed release must carry the reviewed migration.
The gate runs in the installed updater. Updaters released after 0.1.0-beta.69
ignore comments, blank lines and `healthcheck:` blocks in `compose.yaml`, so a
probe-only change installs on agents already running such a release; beta.69
and older still refuse it.
CI's `upgrade-from-release` job (`pnpm upgrade:check`) runs the published
release's updater against every PR: eligibility, including this gate, and each
preparation step up to the image build. When it fails, installed agents would
refuse or break on that change; ship the migration in a release they already
run first, or bootstrap the agents. It covers only the `latest` updater: before
publishing, still check that agents on older releases can take the change.

## Shared publisher updates

A plugin's `publish-beta.yml` calls the shared workflow pinned by commit SHA, in
both `uses: ...@SHA` and `publisher-sha`. A change merged here (for example tag
creation, the longer registry readback or finishing the GitHub release) therefore reaches a plugin only when it
bumps that pin; an old pin keeps the old behavior. Bump it in the plugin's own
PR before its next release, never as an edit during the release:

1. Take the full SHA of the merged core commit that contains the change.
2. In a core checkout at that SHA, print the caller with the plugin's current
   required checks and copy the output over the plugin's
   `.github/workflows/publish-beta.yml`:
   `node scripts/generate-publish-caller.mjs OWNER/REPO @jc_stack/PACKAGE FULL_SHA '["check name", ...]'`.
3. Review the diff: the two pins change; the check list, inputs and permissions
   (`contents: write` and `actions: read`, which the release-finishing job needs,
   are already granted) must not.
4. Merge it with the plugin's normal review and CI. The npm trusted-publisher
   enrollment names `publish-beta.yml` and is unaffected.

A plugin still on an older pin ends the old way: after readback, upload
`SHA256SUMS` and the run's `publication-receipt.json` with `gh release upload`,
then publish the draft with
`gh release edit vVERSION --draft=false --prerelease --latest=false`.
