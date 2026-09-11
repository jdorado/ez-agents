# Approval-only Telegram transport

`ezenciel-agents-approval-channel` delivers backend-owned approval cards and owner
button decisions without constructing a relay, pairing flow, inbox or executor.
It reuses the ordinary relay's `telegram-message.ts` formatting and pacing. Domain
validation, immutable requests, approval expiry and action execution belong to
the application backend. This transport never approves free text.

Mount a private JSON configuration at `EZ_APPROVAL_CONFIG` (default
`/run/secrets/approval-config.json`) with `bot_token`, backend origin `url` and a
separate approval capability `token`. The backend's `/approval/identity` returns
the fixed bot, owner user, private chat and durable update offset. Startup checks
Telegram `getMe` against the bound bot ID. Use one process/poller for this bot;
in Docker run the command under `flock -n /state/approval.lock` with a private
persistent state volume. There is no shared state with the conversational bot.

Backend protocol: `POST claim` reserves one immutable card; `POST delivered`
binds its Telegram message ID; `POST decide` supplies the original callback
identity; `POST cursor` commits update progress; `GET updates` returns current
cards for idempotent message editing. All routes use the approval bearer token.
Claims are not reissued after an uncertain send. Cursor advancement follows
durable decision handling. Network errors retain the update for replay; the
backend must deduplicate identical decision receipts. Keep callback values below
Telegram's 64-byte limit and complete cards below 3500 characters.

Run this service under an identity with no agent/provider tools, host executor,
Docker socket or writable application code. A second bot is a distinct identity,
not a security boundary by itself; the application must isolate credentials,
ledger and action capability from its agent. Never expose the approval credential
to an agent plugin or accept caller-provided approval JSON on a proposal route.
