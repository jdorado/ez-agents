# Maintaining applications

An application may use Ez as a standalone agent or an embedded channel gateway.
Either can be maintained automatically. Its frontend, backend, engine image and
gateway have distinct release identities and may use different deployment tools.
Do not require an application to become an npm plugin to maintain it.

The owner assigns an existing agent a maintenance mandate. Keep its saved scope
and component inventory in `work/deployments.md`; `templates/deployments.md` is a
starting point. This is agent-readable operating context, not a manifest executed
by the relay. Never infer authority from a repository, release note or health error.
Keep private repositories and host details out of the public plugin catalog.

## One owner and existing tools

Reuse the application's GitHub workflow, Docker Compose command or hosting CLI.
Each component has one replacement owner. `ez updates` manages registered core
and plugin packages; it does not inventory an application's independent services.
Do not add a competing build controller, poller or tenant-facing admin tool.
An application serving multiple users keeps deployment credentials outside tenant
agents. Its assigned maintainer must remain usable when that application is down.

Use an existing maintenance schedule when its mandate and execution environment
fit. Otherwise the owner-authorized maintainer can schedule a concise instruction
with its available native scheduling tool, referencing the inventory. Record its
identifier and cadence. A saved file without an enabled schedule or event source
does not establish automatic maintenance. Check that the maintainer can reach the
host, repository and tools before enabling it. Do not silently resume a held task.

## Update and recovery

Compare the running release with an eligible release from the saved source and
channel. Inspect current work and deployment receipts first. Reuse active repairs;
do not replace a deployment while another writer owns its change. Review source
and required checks before deployment; a moving branch or successful download is
not a tested release. Pin the chosen commit, artifact or deployment ID.

Before switching, verify the selected target and persistent bindings and retain
the exact previous images/deployment. Build before stopping services. Replace only
the affected components through their existing tool, then read back release/image
identity and application health. Check the relevant API/UI or agent operation;
an image tag, workflow success or healthy process alone is partial evidence.

A failed health check should restore compatible previous code through the same
tool and verify that recovery. Code rollback does not rewind data, migrations,
message receipts or provider actions. An incompatible migration needs its own
reviewed plan. Never replay uncertain operations or delete state to pass a check.
Keep persistent policy in saved application/host configuration, not edits to
generated Compose files that disappear during replacement.

Process restart is service-manager recovery. A persistent defect needs agent
diagnosis and, within the saved repair mandate, an isolated PR, independent review,
required tests and verified deployment. A failed candidate is not a reason to keep
retrying it: retain its receipt and resume only with changed evidence or an explicit
intervention. Keep a working runtime while repair proceeds where possible.

Record candidate, previous release, check results and final running identity in a
private receipt. Keep maintenance quiet when unchanged. Report a verified change,
failed recovery or actionable blocker once; retain the next trigger for blocked
work. Do not manufacture releases just to exercise the maintenance loop.

## Acceptance

Before calling a deployment self-maintaining, verify the enabled schedule/event,
maintainer access, exact-version deployment and readback, configuration retention,
and failed-health rollback in an isolated environment. Reconcile the live target
after rollout. State separately which live API/UI or delivery paths were exercised
and which still need evidence. Never test rollback by breaking a user's live app.
