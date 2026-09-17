# Contributing

Humans, LLM agents and maintainers use the same small-PR process. Read AGENTS.md
and the relevant CLI help first. Open an issue for substantial scope changes;
small fixes need no proposal. Internal plans and private QA belong outside this
repository. Public docs describe shipped behavior and explicit limitations.

1. Start one coherent change in a dedicated worktree from fetched origin/main,
   following the isolated-work rules below. Preserve unrelated work.
2. Install Node 22+ and pnpm 10.30.3. Run `pnpm install --frozen-lockfile`.
3. Apply AGENTS.md’s KISS change gate: identify the failed boundary, remove
   unnecessary behavior first, and explain why remaining code is needed. Change
   the code, user instructions and focused tests together. Authority,
   paths, credentials, cancellation and uncertain writes need negative tests.
4. Run `pnpm verify`, `npm run release:check` and `git diff --check`.
   Packaging/runtime changes also need the Docker checks in docs/releasing.md.
5. Open a PR explaining the problem, resulting behavior, verification and limits.
   Include a short sanitized reproduction. State which tests were not run.
6. Obtain one bounded independent final-head review and required CI, resolve
   material findings, then complete the authorized merge. An owner or maintainer
   request for a product change or fix authorizes this normal PR/merge loop;
   unsolicited external contributions still require maintainer merge authority.
   No CLA, ticket requirement, custom commit format or additional approval committee.

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

## Proportional scope and validation

Follow AGENTS.md's fast KISS iteration principle. Define the smallest useful
increment, verify the main user path and relevant failure boundaries, and run
required checks. Once these pass and the architecture is preserved, finish the
authorized delivery. Do not expand scope or repeat tests to cover hypothetical,
low-impact edge cases. No new tests are needed merely to mirror wording or an
obvious reversible edit. Broaden verification only when evidence warrants it.
Reviewers must distinguish material blockers from optional follow-ups; briefly
record real deferred limitations without making them conditions of this PR.

## Architecture check for every PR

Authors and reviewers apply the [engine and application boundaries](README.md#engine-and-application-boundaries)
to every proposed or revised core/plugin change. State the failing boundary,
what can be removed or simplified, which component owns each remaining
responsibility, and the focused evidence for the fix. Evaluate instructions,
retries and lifecycle owners as implementation complexity too.

The independent reviewer must confirm that the final diff preserves this boundary;
passing CI or fixing the immediate symptom is insufficient. Reject replacement
conversation/prompt assembly, competing agent-turn runners or queues, and domain
workflows in transport. Preserve necessary authorization, persistence and delivery
safeguards, standard controls, and the intentional engine-decided chat guidance.
Resolve violations before approval or merge. Report existing out-of-scope problems
with sanitized evidence and a next action in an existing issue when available;
do not disguise them as supported architecture or start a duplicate repair.

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
- Push the task branch and open a PR when the coherent change is reviewable. Use
  draft status only while implementation or a named gate remains incomplete; do
  not leave completed mergeable work in a draft or only on a local branch.
  Publication remains a separate authority boundary.
- Every handoff names the repository, worktree, branch, exact commit, PR URL,
  checks, independent-review status and remaining QA with its next action. If
  pushing or PR creation is blocked, report the blocker and preserved local
  commit; do not call the PR workflow complete. Resume the same task branch.
- Integration/release worktrees are task worktrees too. Give any unique fix its
  own PR or include it in the explicitly scoped integration PR; never leave a
  successful local integration as the only copy of a fix.
- Before merge, obtain an independent human or agent review of the final diff.
  The implementer's self-check and passing CI are not independent review.
  Reviewers inspect correctness, architecture, state/permissions and negative
  cases. Record reviewer identity/session, reviewed commit, findings and resolution
  in the PR. If review is unavailable, leave it explicitly pending.
- New substantive commits or conflict resolutions invalidate the affected review
  and test evidence. Refresh against current main, review the resulting diff and
  run the applicable checks. Do not bypass protected-branch requirements.
- Merge only after review, required CI and applicable QA under the authority in
  the contribution checklist above. Publish only under the separate release
  process; commits and merges are not releases. Record which source commit and
  artifact hash were tested.
- Keep the worktree while its PR or QA is open. After merge or explicit abandonment,
  inspect it for uncommitted/untracked files and local-only commits. Remove only
  the clean task worktree after valuable work is preserved; never force cleanup.
  Delete its branch only after confirming merge or authorized abandonment.
- The agent completing an authorized merge owns the cleanup check in that same
  task. Fetch current main and read back the PR state and merged head; a clean
  status or an ahead/behind count alone is not merge evidence. Squash/rebase
  merges may require PR-head ancestry or patch-equivalence checks. Any commits
  added after the reviewed PR head must be accounted for separately.
- Before removal, check ignored files as well as tracked/untracked files, and
  confirm the path is not used by an active task, runtime or pending QA. Preserve
  local state and evidence; do not use force removal or blanket pruning. Report
  either the removed worktree or a concrete retention reason and next action.
  Keep upgrade QA worktrees until their explicit acceptance or abandonment.

## Agent-owned release handoff

The agent owns the engineering work through shipping: implement, run proportional
checks, obtain independent review, repair findings, verify the packed artifact,
and prepare the release. Reuse valid final-commit evidence; repeat checks when
changes or failures invalidate it. Do not leave a ready feature silently in draft
or ask the maintainer to run commands, coordinate reviewers, or operate CI.

The owner or maintainer request authorizes the requested work and its normal
PR/merge steps; do not ask them to approve the same work again. Release remains
separate authority: a request to merge does not authorize publication or changing
a private package's visibility, while a request to release authorizes the merge
and publication needed for that release. Prepare and verify the reviewed commits,
artifacts and checksums before shipping. If release was not requested, stop after
the merged contribution loop and report any distinct deployment or publication
step without performing it.

When release is authorized, complete publication using docs/releasing.md, then
verify registry metadata, the downloaded artifact and any explicitly requested
installed-runtime QA. Deployment is separate and requires a direct rollout
request or the target's saved update policy. Report the outcome. Escalate only a
product decision, missing credential/2FA, failed gate that cannot be repaired in
scope, or material scope change. Human attention belongs on product intent; the
agent operates the technical workflow.

Example, substituting a unique task name and an absolute external directory:

```sh
git status --short
git worktree list
git fetch origin
git worktree add -b feat/task-name /absolute/worktrees/task-name origin/main
```

Beta publishing workflow changes follow [trusted publishing](docs/trusted-publishing.md).
Validate wrong source, repository, package, version and artifact inputs with
negative tests. Never dispatch publication to test authentication.

Finished work leaves zero task worktrees. Worktrees are temporary for active
implementation, PR review and specific unfinished acceptance steps. A merged
change, a completed release or a possible future follow-up is not a reason to
retain its checkout. Record deferred work in the PR/issue with its next action;
recreate a worktree from the preserved commit when that work actually resumes.
Every retained worktree must name an active task or a concrete unfinished gate.
