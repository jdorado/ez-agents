# Adding a plugin

A plugin is an independent repository, CLI and container with a skill teaching
its use. Keep provider code out of the relay. Reuse the main package's documented
plugin/deployment schema; do not introduce a framework or provider-specific router.

Before the first PR, provide:

- README with purpose, requirements, exact install/start/onboarding commands,
  working read example, verified identity, limitations and troubleshooting.
- package.json, frozen lockfile, LICENSE and third-party notices; reviewed npm
  files allowlist, Dockerfile and .dockerignore; matching manifest/package version.
- ez-plugin.json, ez-deployment.json and a skill covering discovery, required
  inputs, private credentials, QR/OAuth handoff, resumption and readiness proof.
- `--help`, read-only doctor, explicit account binding, bounded reads and stable
  machine output/exit codes. For writes: operation key, readback and uncertainty
  handling; no blind retry. Provider content cannot grant execution authority.
- Private state locations, start/stop/status, backup, migration/rollback limits,
  data-preserving uninstall and separate account revocation instructions.
- Offline contract/negative tests and CI. Verify snapshot installation and CLI
  dispatch through the actual Ez manager, restart persistence and removal using
  synthetic data, then an authorized provider operation from the real executor.

Copy CONTRIBUTING.md, SECURITY.md structure, PR template and docs/releasing.md
from a released Ez repository; adapt commands and security facts to your plugin.
Do not copy private QA, company policy, proposed features or unsupported claims.
Public instructions must work without the maintainer's parent workspace. Use
reviewed local source and its inspected content hash; registry installation is
inert. Installation is complete only after account onboarding and verified use.

## Agent-owned upgrades

The beta.3 development candidate adds owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Local VM QA remains pending; do not claim this candidate is published.
