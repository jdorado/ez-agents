# Third-party software

This repository's original source is MIT (LICENSE). Dependencies retain their
own copyright and licenses; our LICENSE does not relicense them. Preserve the
license files installed with every dependency and the frozen pnpm-lock.yaml.
Node/Debian container layers and optional external CLIs have separate terms.
The container is built locally; no bundled third-party binary image is promised.

Direct runtime dependencies: grammy (MIT), tsx (MIT). Development dependencies
include TypeScript (Apache-2.0) and Node type definitions (MIT). The runtime
image installs ffmpeg, Debian packages, and these reviewed CLI versions:
`@openai/codex` 0.153.4 (Apache-2.0), `opencode-ai` 1.18.32 (MIT),
`@earendil-works/pi-coding-agent` 0.87.1 (MIT), and
`unreal-agent-runner` 0.1.1 (MIT; Copyright 2026 Unreal Labs). The Unreal
Agent binary comes from the upstream release with SHA256SUMS verification;
its [license](https://github.com/unreallabsai/unreal-agent/blob/v0.1.1/LICENSE)
applies to that binary. Redistributing the image requires review of its exact
package build, notices and corresponding-source obligations. Docker and
host-capable AI CLIs remain separately installed products, not covered by this
repository's MIT license.
