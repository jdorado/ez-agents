# Releasing

Use the same checks for maintainer and external changes. Each repository versions
independently with SemVer: patch for compatible fixes, minor for new capabilities;
before 1.0, breaking CLI/state changes require a minor bump and migration notes.
No automatic dependency updates, release bot or credentials in pull-request CI.

1. Merge a reviewed PR with green CI. Finalize package version and CHANGELOG.md;
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
   with CI and PR review (a sole maintainer may self-review explicitly).
7. Obtain maintainer release approval for the exact commit, tarball SHA-256,
   license/third-party obligations and known limits. Only then push the approved
   public tree, tag `v<version>`, and publish that tarball:
   `npm publish /absolute/candidate.tgz --access public --registry https://registry.npmjs.org/`.
   Use interactive npm authentication with 2FA; never paste tokens into CI or docs.
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
`--tag beta`; never mark a beta latest/stable. For this first beta the maintainer
explicitly deferred real account/reboot acceptance. Keep that limitation in the
README and release notes. Source/tarball publication is permitted after the
automated gates; deferred live checks remain required for stable release.
GitHub is the initial distribution channel; npm needs its own authenticated
publisher. A GitHub username does not prove ownership of the same npm scope.
