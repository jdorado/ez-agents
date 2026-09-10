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
   publishing job need `id-token: write`; test/validation jobs do not receive it.
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
update it when repository policy adds checks.

Create the `vVERSION` tag at that exact source commit and a **draft prerelease**
with these assets, using native `gh release create --draft --prerelease` and
`gh release upload` under existing release authority:

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

Only `X.Y.Z-beta.N` versions and the npm `beta` tag are supported. Private
packages, wrong package/repository identities and stable versions fail before
publication. No npm login smoke publication or stable/latest promotion occurs.

## Readback, failure and release completion

The publisher reads registry metadata, checks the beta tag and downloads the
published tarball to compare its SHA-256. It also checks that `latest` did not
change. Preserve the workflow's readback receipt, run URL and source/artifact
identity on the release PR. A failed command after the publish call may mean npm
accepted it: inspect registry state first. A rerun may verify an existing exact
version; if the version is absent it refuses a second write. Reconcile first,
then create a fresh authorized dispatch if appropriate. Never repeat or overwrite that version or silently repair tags.
Missing trust or registry access is an external dependency, not a reason to use
a token workaround.

After successful registry readback, finish the GitHub prerelease with the tested
artifact/checksum and verify its public availability. Perform the clean-host
installation and runtime/provider checks required by the package's release
rules. Actions success proves registry delivery only; it does not prove a
running agent was upgraded. Respect each installation's saved update policy.
