# Application channel backend

An optional backend receives owner-authorized Telegram turns instead of a CLI.
The existing private-chat gate, inbox batching, media downloads and outbox remain
in use. This is still one approved owner per bot, not shared-bot tenant routing.

Set `EZ_CHANNEL_BACKEND_URL` to an HTTPS endpoint and put
`EZ_CHANNEL_BACKEND_TOKEN` in the private relay env file. For Compose also set
`EZ_EXECUTOR_TRANSPORT=backend`; no host CLI heartbeat is required. The existing
workspace/control paths and pairing remain mandatory. Loopback HTTP is allowed
for isolated local tests. Redirects and URL credentials are rejected.

POST carries version 1, channel `telegram`, stable `event_id`, numeric strings
`sender_id` / `chat_id`, and `items` with text, message_id, sent_at, album_id and
optional attachment `{type,data}` (base64, at most 12 MB decoded per item).
The application must bound and validate the whole body, bind sender identity to
its authenticated account, and deduplicate the stable event ID before actions.
It must support up to ten normalized items, including a received album.

The response is `{status,reply}`. `queued` or `running` yields and resubmits the
same event after four seconds. `complete` or `failed` supplies a final string
reply, queued once with a deterministic outbox ID. Backend completion and
Telegram delivery are separate; an uncertain send never replays the operation.
Restart resubmits interrupted backend runs using the original ID. Permanent
4xx responses leave a failed relay run for operator inspection; transient
failures back off. No response body or credential is logged.

Native `/new` and AI settings belong to the application. `/stop` cannot cancel
an application job and explicitly reports that limitation. `/cancel` removes
pending relay work only; it does not undo work already accepted by a backend.
External plugin/maintenance wakes do not dispatch through this channel backend.
