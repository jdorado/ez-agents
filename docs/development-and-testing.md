# Development and testing

Use Node 22+ and pnpm 10.30.3: `pnpm install --frozen-lockfile`, then
`pnpm verify`. Tests use temporary synthetic state; TypeScript checks source and
tests. Use `npm run release:check` for package contents. See CONTRIBUTING.md for
PR expectations and [release checks](releasing.md) for Docker and clean-host QA.

For the cross-repository fixture, place the reviewed WhatsApp source beside this
repository as `ez_whatsapp` and run `node docker/plugin-smoke.mjs`. For another
location, set `EZ_WHATSAPP_SOURCE=/absolute/reviewed/whatsapp/package`. It installs
through the real manager with synthetic provider data, checks dispatch,
operation replay, restart and retained data on uninstall, then removes its own
fixture resources. It never uses an existing linked account.

`pnpm smoke` contacts Telegram and invokes the selected AI. It proves outbound
reply delivery, not incoming onboarding. Stop the exact poller first, use a
dedicated authorized account, and follow docs/setup.md for the full incoming
path. Never revoke a working owner or reuse production profiles as fixtures.
