# Native repair ownership

Every deployed agent is a repairer by default. When an agent finds a core or
plugin defect, it keeps the context and pursues a tested contribution PR. The
core injects the same mandate into CLI/native and desktop execution, including
existing workspaces; it does not replace the agent's mind or implement a repair
workflow engine. Use native Git/GitHub CLI or the installed GitHub plugin.

The agent searches for the same cause, registers a sanitized issue, requests a
claim, then works in an isolated contribution checkout after the coordinator's
grant. It resumes the same issue/branch/PR after interruption. The installed
runtime is never the repair checkout. Missing credentials or coordination remain
recorded blockers; the default does not invent repository access. Public reports
must exclude private runtime data and use the security reporting route when needed.

One coordinator grants claims sequentially per repository. Assignment alone is
not a lock. All participating agents must use that coordinator; this convention
cannot prevent an unrelated public contributor from opening a competing PR.
The discovering agent remains the repairer, including when its work moves to a
background task. The coordinator reconciles duplicates and stalled claims. The
maintainer independently reviews and tests, then merges/publishes only within
separate owner-approved policies. Start from templates/maintainer-purpose.md.

## Disable

Set `EZ_REPAIR_ENABLED=false` in the deployment's Docker environment and recreate
the relay. The resolved setting crosses the host transport and is included in
every new execution prompt; the default is true and invalid values fail startup.
This changes the automatic mandate, not filesystem/GitHub permissions, and does
not cancel an already running task. Explicitly stop active repair work when needed.
An owner can also disable repairs globally or for a repository in the agent's
saved USER.md preferences; carry those restrictions into background task context.

## Setup boundary

The shipped mandate and maintainer purpose do not provision a GitHub account,
coordinator service or publishing token. Enroll the allowed repositories and
configure one maintainer execution lane on the owner's host before unattended
claims. Reuse authenticated GitHub CLI where authorized. Repository push and PR
permissions are distinct from package-registry publication and protected-branch
approval. Never put credentials in prompts, issues or test environments.
