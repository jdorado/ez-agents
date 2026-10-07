# Third-party software

This repository's original source is MIT (LICENSE). Dependencies retain their
own copyright and licenses; our LICENSE does not relicense them. Preserve the
license files installed with every dependency and the frozen pnpm-lock.yaml.
Node/Debian container layers and optional external CLIs have separate terms.
The container is built locally; no bundled third-party binary image is promised.

Direct runtime dependencies: grammy (MIT), tsx (MIT). Development dependencies
include TypeScript (Apache-2.0) and Node type definitions (MIT). The runtime
image installs ffmpeg, Poppler (`poppler-utils`, GPL-2.0-or-later), Debian packages, and these reviewed CLI versions:
`@openai/codex` (Apache-2.0; the build resolves and records the selected version),
`opencode-ai` 1.18.32 (MIT), `@earendil-works/pi-coding-agent` 0.87.1 (MIT), and
`@anthropic-ai/claude-code` 2.1.286 (proprietary; Anthropic's legal agreements,
as referenced by its installed LICENSE.md, govern use). Preserve its installed
license and README; it is not covered by this repository's MIT license. Redistributing the image
requires review of its exact package build, notices and corresponding-source
obligations. Docker and
host-capable AI CLIs remain separately installed products, not covered by this
repository's MIT license.
