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
Do not upload conversation dumps, credentials, QR codes or customer records.
Installation authority alone does not authorize messaging another person.
Use synthetic providers for routine tests; live tests need a dedicated account
and explicit recipient authority. A process exit is not provider delivery proof.

Report bugs through a GitHub issue with version, OS, Node/Docker versions,
minimal steps, expected/actual behavior and sanitized output. Feature requests
should explain the user problem and a small acceptance example. Security reports
follow SECURITY.md. Release and new-plugin requirements: docs/releasing.md and
docs/plugin-contributions.md.
