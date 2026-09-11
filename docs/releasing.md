# Releasing

Use the same checks for maintainer and external changes. Each repository versions
independently with SemVer: patch for compatible fixes, minor for new capabilities;
before 1.0, breaking CLI/state changes require a minor bump and migration notes.
No automatic dependency updates or credentials in pull-request CI. The agent
operates this process under the authorization rules in CONTRIBUTING.md; a
separate release bot is not required.

Use one release loop: current `main` -> reviewed and tested source -> immutable
candidate artifact and draft prerelease -> OIDC publication -> registry/digest
readback -> installed-runtime receipt -> cleanup. A direct release/ship request
or active maintainer release objective authorizes that loop; do not ask again
once it is established. A merge alone is not publication authority.

1. In an isolated release worktree/PR, finalize package version and CHANGELOG.md;
   update plugin manifest version when present. After lockfile changes, copy
   `pnpm-lock.yaml` to `docker/pnpm-lock.yaml` (npm omits the root lockfile; CI
   checks this shipping copy is identical). Never overwrite a published version.
2. Run `pnpm install --frozen-lockfile`, `pnpm verify`, `npm run release:check`,
   `git diff --check`. Review `npm audit --omit=dev` and dependency licenses.
   Record accepted risks with a reason; never run an unreviewed audit fix.
3. Build both Docker targets from a clean checkout:
   `docker build --target test -t ez-release-tests .` and
   `docker build --target runtime -t ez-release-runtime .`.
   Main: `EZ_RELAY_IMAGE=ez-release-runtime node docker/smoke.mjs`.
   WhatsApp: `EZ_WHATSAPP_IMAGE=ez-release-runtime node docker/smoke.mjs`.
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
   not a claim that a SemVer prerelease is stable.
   For unattended beta publication use the [shared trusted publisher](trusted-publishing.md)
   and its exact-artifact staging/readback contract. Initial package publication
   requires authenticated npm with 2FA before trust can be enrolled; never paste
   tokens into CI or docs.
8. Create the GitHub release from CHANGELOG.md, attach artifact/checksum, and
   install the registry version on a clean host. Verify metadata and the same
   onboarding path before posting launch copy. Stop rollout on failure; publish
   a new patch or deprecate the bad version, never silently replace an artifact.

Container images are built locally in this initial release. Public image
publication is a separate decision and requires the corresponding source and
third-party notices. Back up private state before upgrades. Uninstall is not
credential revocation; do not delete volumes as a routine rollback.

## Beta channel

Use SemVer prereleases (`0.1.0-beta.1`), GitHub's prerelease flag and npm's
`--tag latest` so default installs and the package page advance automatically.
The version and GitHub release remain prereleases; stable-only update policies
still exclude them. The legacy npm beta tag is no longer advanced. For this first beta the maintainer
explicitly deferred real account/reboot acceptance. Keep that limitation in the
README and release notes. Source/tarball publication is permitted after the
automated gates; deferred live checks remain required for stable release.
GitHub repositories use `jdorado`; npm packages use `jc_stack`. Verify
`npm whoami --registry https://registry.npmjs.org/` returns `jc_stack` before
interactive publication. OIDC publication instead requires package-owner trust
enrollment for the exact caller workflow; `whoami` is not its publication gate. Never infer npm scope ownership from a GitHub login. After publishing,
read back `npm view @jc_stack/ez-agents@0.1.0-beta.12 name version dist-tags --json`
(using the release being published), download it with `npm pack`, and verify its
contents/checksum against the reviewed artifact. Keep the npm artifact and
GitHub tag on the same reviewed commit. Do not create a new token to bypass 2FA.

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.
