# Isolated plugin update readiness
Status: proposed acceptance contract; not a claim of installed behavior.
Source baseline: f192d57d8b1ea2748fe31544ffdb968c827b891e.
Scope: one causal repair to isolated broker activation and verification.

## Objective and boundaries
An authorized plugin update must leave the isolated native execution path able to resolve and prepare the exact reviewed plugin revision, or report failure with the existing recovery path. A successful host-side command, running container or socket is insufficient.

Constraints:
1. Preserve reviewed-revision, host-network, folder, owner and per-run authorization checks. Never authorize a revision merely to make a probe pass.
2. Keep one registry, broker and updater; no new daemon, retry controller, scheduler or financial workflow.
3. Preserve the relay, native sessions, unrelated plugins and persistent state during plugin-only refresh.
4. No credentials, customer data or production run identities in tests or public receipts.
5. Existing update serialization, active-work admission and uncertain-write reconciliation remain binding.

Owner: updater/broker boundary, principally src/updates/runtime.mjs and existing plugin validation. This does not change domain procedures or models.

## Observed mechanism and confidence
compose.yaml bind-mounts the host configuration as a single read-only file into plugin-broker. Configuration writers use temporary-file plus rename. A single-file bind mount can retain the prior inode after host-side atomic replacement. The plugin registry can therefore select the new reviewed revision while the broker still sees the old revision list. hostNetworkBindings in src/plugins/manager.mjs correctly rejects that mismatch.

refreshBroker currently invokes Compose restart after plugin registry activation and rollback. That does not explicitly recreate the container/mount. The current broker health check only verifies socket existence. The existing updater regression test confirms restart and inventory version, not mounted configuration identity or executable readiness.

Production diagnosis observed different host and mounted revision authorization, and targeted broker recreation restored the failing boundary. This supports the stale-mount mechanism; the exact historical writer/commit that first replaced the file is not yet established. Do not invent that provenance or attribute every domain deferral to this incident.

## Smallest implementation
First reproduce the failure with a synthetic deployment. Prefer fixing lifecycle of the existing narrowly scoped mount rather than broadening the mount or making authorization mutable inside the broker.

1. After approved activation changes and registry publication, refresh the isolated broker using the deployment's existing Compose identity and exact installed image. Recreate only plugin-broker, without dependencies/build/pull or relay replacement, and wait for readiness. Use supported equivalent Compose flags rather than hardcoding another project or image.
2. Apply the same mount-refresh rule to rollback. Restore the old registry/config state owned by the existing transaction, then verify the old revision is again usable. Never restore provider journals or silently erase subsequent unrelated state.
3. Ensure every updater path that replaces a relevant host file and retains an unchanged broker image cannot skip mount refresh merely because Compose sees the same image/configuration. Include main-update activation/rollback where relevant; do not gratuitously recreate healthy relay processes.
4. Before completed, compare broker-visible configuration identity with the intended host configuration and verify installed registry/source revision consistency and existing host-network/folder validation. The check must execute inside the actual isolated broker environment, be read-only and bounded, and expose no configuration contents or secrets.
5. Separate structural readiness from real native invocation evidence. A structural probe must not fabricate EZ_RUN_ID, borrow another run, create permanent authorization, or invoke an arbitrary plugin command that might mutate. Prefer existing prepare/validation primitives with a narrowly scoped trusted diagnostic if no supported read-only probe exists. An actual harmless command through a genuine authorized native run is a separate acceptance step.
6. A mismatched pin, missing mounted file, failed recreate or failed verification must prevent completed. Use current failed/rollback/recovery-required states and preserve error evidence. Do not swallow probe failures.
7. Keep socket liveness distinguishable from functional readiness in existing status/diagnostics. Do not build an expensive provider poll into a high-frequency health check or restart endlessly. Document exactly what each level proves.

If code inspection finds a simpler existing supported mechanism meeting all these requirements, use it and explain the equivalence in the PR. Do not bypass pinning, rewrite authorized revisions, mount the entire private deployment directory, or switch execution transport.

## Regression evidence
Use synthetic, isolated state and real Docker bind-mount behavior where required:
- Start with approved revision A and a single-file read-only host binding.
- Atomically replace host configuration with independently approved revision B and activate registry B; reproduce old mounted bytes and rejection in the uncorrected harness.
- Apply corrected refresh; prove broker sees exact new file identity/content hash and prepares B successfully. Record container identity change and unchanged relay identity.
- Prove a still-unapproved B remains rejected. Recreate is not authorization.
- Cover rollback B to A, including mounted bytes, registry identity and readiness.
- Recreate failure and readback/probe failure must not return completed.
- A socket that exists while configuration is stale or invalid must not count as functional-ready.
- Host-capable updates should not start an isolated broker.
- Preserve existing invalid owner/run, canceled/revoked admission, folder/network mismatch and secret-isolation tests relevant to changed code.
- Respect active work through existing updater admission. Do not manufacture a second drain/queue mechanism.

Update the existing restart-only test to assert the meaningful behavior. Mocked Compose argument assertions alone cannot prove Linux bind-mount recovery. No test should require customer credentials or invoke a financial command.

## Verification and review
Run required repository checks on final source: pnpm verify, pnpm run release:check, git diff --check and applicable Docker/packed-artifact checks in docs/releasing.md. Identify test counts, skipped/unrun checks and exact commit/artifact hash honestly. Keep one focused PR and do not include unrelated media work.

The implementation author supplies the final diff, root-cause reproduction, before/after evidence and limits. The assigned reviewer personally checks architecture, correctness, negative cases and exact-head CI, then merges using expected-head protection. Changes after review require affected revalidation. This specification is authored by the reviewer; its authorship is disclosed, and implementation verification must not be described as independent review of the reviewer's own design.

## Direct VM acceptance after merge
Use the deployment's supported updater on the reviewed artifact. Before activation, record non-secret installed revision/image identities, native active-work state and baseline read-only access; preserve ongoing work and use the updater's normal drain. Never force a restart during an active call.

Verify exact installed commit/artifact and broker/relay identities, mounted configuration fingerprint, reviewed registry identity and structural readiness. Then inspect a genuine native invocation using the same bound launcher, with a harmless help/manifest read and its real run receipt. Do not trigger scores, leverage, trades or other investment workflows as a smoke test. If no authorized diagnostic invocation exists, retain native proof pending the next natural invocation rather than inventing identity.

Success: the corrected lifecycle demonstrably handles atomic binding replacement and rollback, and the installed isolated path accepts the already authorized revision without operator recreation. Source merge, service health and a host-side doctor alone are not success.

## Separate subsequent work
Outage-to-engineering acknowledgement, recovery/resumption ownership, large-file archive transfer and shared daily-ledger contention are separate causes. They remain follow-up investigations; do not add automatic domain replay, broaden stdin limits, change schedules or rewrite record ownership in this PR.
