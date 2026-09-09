# Contributing

Humans, LLM agents and maintainers use the same small-PR process. Read AGENTS.md
and the relevant CLI help first. Open an issue for substantial scope changes;
small fixes need no proposal. Internal plans and private QA belong outside this
repository. Public docs describe shipped behavior and explicit limitations.

1. Fork/branch from main and make one coherent change. Preserve unrelated work.
2. Install Node 22+ and pnpm 10.30.3. Run `pnpm install --frozen-lockfile`.
3. Change the code, user instructions and focused tests together. Authority,
   paths, credentials, cancellation and uncertain writes need negative tests.
4. Run `pnpm verify`, `npm run release:check` and `git diff --check`.
   Packaging/runtime changes also need the Docker checks in docs/releasing.md.
5. Open a PR explaining the problem, resulting behavior, verification and limits.
   Include a short sanitized reproduction. State which tests were not run.
6. A maintainer reviews and merges after CI. Maintainers use PRs too. No CLA,
   ticket requirement, custom commit format or additional approval committee.

You are responsible for understanding submitted code, including AI-generated
code, and having the right to contribute it under this repository's license.
For unreleased feature testing, follow [local QA](docs/local-qa.md): stage an
immutable beta candidate and provide a simple PA upgrade instruction and feature
QA flow. A public release is not required for this handoff.
Do not upload conversation dumps, credentials, QR codes or customer records.
Installation authority alone does not authorize messaging another person.
Use synthetic providers for routine tests; live tests need a dedicated account
and explicit recipient authority. A process exit is not provider delivery proof.

Report bugs through a GitHub issue with version, OS, Node/Docker versions,
minimal steps, expected/actual behavior and sanitized output. Feature requests
should explain the user problem and a small acceptance example. Security reports
follow SECURITY.md. Release and new-plugin requirements: docs/releasing.md and
docs/plugin-contributions.md.

## Isolated work and review

- One coherent change, one branch, one dedicated Git worktree, one PR per
  repository. Create the worktree from freshly fetched origin/main before edits.
  Never develop on main or switch branches in another task's checkout.
- Inspect git status and git worktree list first. Reuse a worktree only for the
  same task. Preserve other work; never stash, reset or commit another task's
  files. Stage explicit paths or hunks and review the staged diff before committing.
- Keep worktrees outside the published package. Each task installs its own
  dependencies and uses separate test state, ports and Docker project names.
  Never share live bot tokens or provider profiles between test instances.
- Keep unrelated fixes/features in separate PRs. For work spanning repositories,
  create one worktree/PR per repository and link dependencies and merge order.
  Branch from an unmerged feature only when the dependency is intentional and
  documented; do not quietly include it in an unrelated PR.
- Open a draft PR when the change is reviewable. Report its scope, exact commit,
  validation and remaining QA. A completed coding task can remain a draft;
  implementation completion does not authorize merge or npm publication.
- Before merge, obtain an independent human or agent review of the final diff.
  The implementer's self-check and passing CI are not independent review.
  Reviewers inspect correctness, architecture, state/permissions and negative
  cases. Record reviewer identity/session, reviewed commit, findings and resolution
  in the PR. If review is unavailable, leave it explicitly pending.
- New substantive commits or conflict resolutions invalidate the affected review
  and test evidence. Refresh against current main, review the resulting diff and
  run the applicable checks. Do not bypass protected-branch requirements.
- Merge only after review, required CI, applicable QA and maintainer authorization.
  Publish only under the separate release process; commits and merges are not
  releases. Record which source commit and artifact hash were tested.
- Keep the worktree while its PR or QA is open. After merge or explicit abandonment,
  inspect it for uncommitted/untracked files and local-only commits. Remove only
  the clean task worktree after valuable work is preserved; never force cleanup.
  Delete its branch only after confirming merge or authorized abandonment.

Example, substituting a unique task name and an absolute external directory:

```sh
git status --short
git worktree list
git fetch origin
git worktree add -b feat/task-name /absolute/worktrees/task-name origin/main
```
