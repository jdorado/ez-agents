# Verified beta publication

The Mac prepares and independently tests the release. GitHub-hosted Actions
publishes the exact approved tarball using npm OIDC. The shared implementation
is `.github/workflows/npm-beta-shared.yml` in this repository; each package has a
small manually dispatched `publish-beta.yml` caller. This setup does not grant
release authority or establish npm trust automatically.

## Enroll a repository once

1. Verify the source is public and explicitly registered in the current
   [public catalog](plugin-catalog.md), or is core itself. Registration does not
   prove a registry release exists. Excluded or private repositories cannot use
   this publisher.
2. Review and merge the shared publisher first. Generate the caller using its
   full immutable commit SHA and the repository's required CI check names:

   ```sh
   node scripts/generate-publish-caller.mjs jdorado/ez-whatsapp \
     @jc_stack/ez-whatsapp FULL_SHARED_COMMIT_SHA \
     '["test (ubuntu-latest, 22)","test (ubuntu-latest, 24)","test (macos-latest, 22)","test (macos-latest, 24)","docker"]' > publish-beta.yml
   ```

   Put that file in the plugin's `.github/workflows/` through its own reviewed
   PR. Inspect the actual CI names; the example does not establish the policy.
   Keep the reusable workflow reference and `publisher-sha` on the same reviewed
   commit. Core uses a local reusable workflow at the dispatch commit. The
   generator writes stdout only; it never grants repository scope or edits npm.
3. The npm package owner authenticates separately and enrolls the exact caller
   repository and filename `publish-beta.yml` as a trusted publisher. Enable
   **direct publication** explicitly; new trust configurations can default to
   staged publication only. If an environment is configured on npm, add that
   exact environment to the shared publishing job through review before use.
   This workflow currently uses no environment.
4. Verify enrollment through npm settings or `npm trust list PACKAGE`. npm
   validates the **calling** workflow for reusable workflows. Both caller and
   publishing job need `id-token: write`; test/validation jobs do not receive it. GitHub requires `contents: write`
   to read unpublished draft assets: only the validation job receives that
   capability and makes GET requests only. The separate OIDC job has
   `contents: read`. No package code or lifecycle scripts run in validation.
   Do not add `NODE_AUTH_TOKEN`, npm tokens, or private profiles to these jobs.

An npm package must already exist before trust enrollment. If a registered
plugin has no registry package, the owner must perform a real, approved initial
beta publication using authenticated npm, with all release checks and exact
artifact readback. Then enroll trust. Do not create a dummy release to test
login. A missing GitHub release likewise remains missing until actually created
and read back; a catalog link or workflow PR is not publication evidence.

Current npm requirements and enrollment fields are documented in
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
The workflow uses Node 24 and npm 11.19.1 on GitHub-hosted Ubuntu runners.

## Prepare and dispatch one beta

Follow [releasing](releasing.md), including isolated Mac tests, packed artifact
inspection, independent review, required CI and authorized merge. The source
must be the exact current `main` commit; after a merge, verify that its tree
matches the tested source and renew invalidated evidence. Wait for that commit's
CI from `.github/workflows/ci.yml`, triggered by a push on `main`. The caller's reviewed list of required checks is a fail-closed minimum;
update it when repository policy adds checks. The validator selects the newest
main-push CI run for that source before checking success, then requires the named
jobs from its latest attempt. Tag, PR and other workflow runs cannot shadow it;
failed, pending or incomplete main CI cannot fall back to an older success.

Create the `vVERSION` tag at that exact source commit and a **draft prerelease**
with these assets under existing release authority. **Creating a draft release
with `--target` does not create a Git tag.** Create and push the tag explicitly,
then use `--verify-tag` to prevent staging against a missing remote tag:

```sh
# VERSION and SOURCE_SHA identify the reviewed, current-main candidate.
git tag "v$VERSION" "$SOURCE_SHA"
git push origin "refs/tags/v$VERSION"
git ls-remote origin "refs/tags/v$VERSION"
# Copy the already tested bytes, without rebuilding, to this exact basename.
cp /absolute/tested-package.tgz /absolute/release/candidate.tgz
gh release create "v$VERSION" --repo OWNER/REPO --verify-tag --draft --prerelease \
  --title "v$VERSION" --notes-file /absolute/release/notes.md \
  /absolute/release/candidate.tgz /absolute/release/release-receipt.json
```

If the tag already exists, read and verify its commit (peel annotated tags) rather
than recreating or force-pushing it. Read back the draft by numeric ID and check
asset names and downloaded SHA-256 before dispatch. `npm pack`'s default filename
is not the publisher's asset name; GitHub asset labels do not rename the asset.
Use `gh release upload` only to add a missing asset, never `--clobber` to replace
candidate bytes or receipts. The required assets are:

- `candidate.tgz`: the exact Mac-tested bytes from `npm pack --ignore-scripts`.
  Do not rebuild it on Actions.
- `release-receipt.json`: a sanitized record with this shape:

  ```json
  {
    "repository": "jdorado/ez-agents",
    "package": "@jc_stack/ez-agents",
    "version": "0.1.0-beta.14",
    "sourceSha": "FULL_TESTED_MAIN_COMMIT_SHA",
    "sha256": "SHA256_OF_CANDIDATE_TGZ",
    "independentReviewUrl": "https://github.com/jdorado/ez-agents/pull/PR_NUMBER#issuecomment-ID",
    "testEvidenceUrls": ["https://github.com/jdorado/ez-agents/actions/runs/RUN_ID"]
  }
  ```

The maintainer verifies those evidence links substantiate independent final-diff
review, artifact tests and accepted beta limitations before dispatch. The receipt
binds that attestation to the commit and digest; a syntactically valid URL alone
cannot prove review quality or release authority.

Read the draft's numeric `id` with `gh api repos/OWNER/REPO/releases` (the
release-by-tag API only returns published releases). Dispatch `publish-beta.yml`
on `main` with `release-id`, `version`, `source-sha` and
`artifact-sha256`. Copy the digest from the independently verified Mac receipt,
not an unreviewed replacement release asset. The validator checks current public
scope, source/tag identity, required GitHub Actions checks, receipt identity,
package metadata and tarball hash. It transfers the validated bytes using an
immutable Actions artifact ID. A fresh job revalidates before publication and
runs npm from a clean directory without package lifecycle scripts.

Only `X.Y.Z-beta.N` versions are supported. Publish to npm `latest` so the
package page and default installs show the newest approved release. Manifests
must use `publishConfig.tag: "latest"` (or omit the tag). The version remains a
SemVer prerelease and the GitHub release remains a prerelease. Private
packages, wrong package/repository identities and stable versions fail before
publication. No npm login smoke publication or stable-version release occurs.

## Readback, failure and release completion

The publisher reads registry metadata, checks that `latest` identifies the released version and downloads the
published tarball to compare its SHA-256. Preserve the workflow's readback receipt, run URL and source/artifact
identity on the release PR. A failed command after the publish call may mean npm
accepted it: inspect registry state first. A rerun may verify an existing exact
version; if the version is absent it refuses a second write. Reconcile first,
then create a fresh authorized dispatch if appropriate. Never repeat or overwrite that version or silently repair tags.
When validation fails, use the logged GitHub API path to identify the missing
input. A tag lookup 404 is not evidence of a draft-release permission problem.
A draft/asset 404 can mean absent evidence or insufficient access; verify with
the existing authorized identity before diagnosing credentials. Do not broaden
token permissions based on a generic 404.

For a failure before the publish job starts, confirm that job was skipped and
read npm for the exact version. If absent, repair missing staging inputs against
the same approved commit/bytes, verify tag, asset names and digest, and create a
fresh dispatch. If main or the package changes, prepare a new reviewed version;
preserve the old draft instead of moving its tag or replacing its artifact.
If any npm write may have started, use exact registry/artifact reconciliation
above first. Publication recovery never means rolling back a running agent.
Runtime upgrades and `failed`/`rolled-back` versus `recovery-required` recovery
follow [upgrades](upgrades.md) under the installation's saved policy.

Missing trust or registry access is an external dependency, not a reason to use
a token workaround.

After successful registry readback, finish the GitHub prerelease with the tested
artifact/checksum and verify its public availability. Perform the clean-host
installation and runtime/provider checks required by the package's release
rules. Actions success proves registry delivery only; it does not prove a
running agent was upgraded. Respect each installation's saved update policy.

## Migration from the legacy beta tag

Existing plugin callers are SHA-pinned: regenerate each caller against the merged
shared-publisher revision and update its package publishConfig together through
review. Old pins retain the old behavior. Do not mutate an already staged or
published artifact; prepare a new version when package metadata changes.

The publisher uses one native npm publish operation with OIDC and `--tag latest`.
It does not synchronize the legacy `beta` tag: npm trusted publishing does not
support standalone dist-tag changes. No extra registry token is needed. Ez beta
update discovery considers both latest and legacy beta during migration; stable-only
policies select non-deprecated stable versions and cannot automatically install a
prerelease. Older installed updaters still following only beta require an explicit
exact-version update to a core release containing this discovery change. Existing
registry versions/tags are not changed by merging the publisher.
