# Local feature QA

Use the existing local-tarball updater for unreleased features. No npm publication,
registry server, new daemon or runtime upgrade flow is needed. A developer stages
an immutable candidate in the PA's local tools directory. The agent reads its
manifest and uses `ez updates prepare main --file ...` and `apply` on the owner's
request. Automatic public update policy stays unchanged.

Stage from a clean, reviewed feature checkout:

```sh
node scripts/stage-qa.mjs --source /absolute/feature-checkout \
  --catalog /absolute/deployment/tools/qa --label beta-12 \
  --version 0.1.0-beta.12.qa.1 --flow /absolute/feature-QA.md
```

`beta-12` is a local catalog label, distinct from public `0.1.0-beta.12`. The
manifest records the private version, source commit and archive SHA-256. Only
package version and `ezQa` provenance metadata differ from the source npm package.
Do not publish these private archives. Each new candidate gets a new label and a
version newer than the PA's installed version; labels are never overwritten.

Add the catalog path and the following instructions to the PA's local policy file, linked from AGENTS.md:

> When the owner requests a beta number, first inspect the matching beta-N entry
> in the local QA catalog. Read manifest.json and QA.md. Check the archive SHA-256
> against the manifest, then prepare that local file using the existing updater.
> Verify the returned version and hash match. Apply only on the owner's explicit
> upgrade request, without --automatic, and finish the turn so the supervisor can
> replace the runtime. On completion, inspect the receipt and both loaded host and
> relay versions before reporting success. Provide the feature's short QA flow.
> If no local entry exists, report that; do not silently substitute a public beta.
> Follow an explicit request for a public npm release separately.

For every feature, the developer handoff includes the beta label, exact private
version, source commit, checks completed and a short user-facing QA flow with
expected results. Include any limitations. A prepared archive or healthy service
does not prove the feature works; read back its result through the PA.

Before handing off a candidate, extract it into a fresh directory, copy
docker/pnpm-lock.yaml to pnpm-lock.yaml, run frozen install and applicable tests,
and prepare it through the target PA's updater. Preparation validates admission
without stopping services. Preserve that receipt for the agent to inspect, and
leave application to the owner's chat request. If deployment/schema compatibility
fails, fix or review the migration; never bypass the updater's checks.
