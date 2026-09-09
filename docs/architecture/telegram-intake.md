# Telegram intake and recovery

One owner, one bot, one relay writer per control directory. No database, extra agent, or executor loop.

1. Gate the sender and paired private chat before accepting work. A paired owner may also make a group check-in; it never grants the group, its members, controls, or approvals authority.
2. Atomically save the raw update and deduplicate its Telegram update ID in `EZ_CONTROL_DIR/inbox.json`.
3. Collect a short burst before downloading/transcribing. Seal batch membership on disk, then normalize in receive order. Captions, album IDs and quoted context travel with the media.
4. Create one durable run using the batch's stable ID. A restart between run creation and intake completion finds that same run; it does not create a second job.
5. The selected CLI executes. Replies still come through the messaging CLI and the receipt-backed outbox.

The polling handler does not wait for media processing or execution. Native controls bypass the work queue, but not the owner gate, and remain private-chat only. Buffered work is checked against the current owner and original chat scope again before processing and execution.

## Recovery boundaries

- Process restart recovers accepted, unstarted messages. Stopping the relay does not discard its intake buffer.
- Attachment downloads and transcription retry transient network errors, timeouts, HTTP 408/429 and selected 5xx responses up to three total attempts. Backoff starts at one second, then two; Retry-After is honored up to thirty seconds, with longer cooldowns left for explicit recovery. Each request has a sixty-second timeout, including body reads. Authentication, certificate and invalid-input errors are not automatically retried. Transcription retries can incur additional provider charges; there is no provider/model fallback.
- Exhausted or permanent normalization failures quarantine the whole batch; later batches can proceed. `/status` exposes the failure and owner-only `/retry` requeues the latest failed incoming batch with its original stable run ID and context. No incomplete-context execution, replay of executed jobs, or automatic retry of external actions/chat sends. Errors identify the request stage and network code without logging credential-bearing URLs or provider payloads.
- `/cancel` cancels buffered/normalizing intake and queued runs, not active execution. A download already in progress may finish staging a file, but its cancelled batch cannot launch.
- `/stop` requests termination of active execution only. It neither clears the queue nor promises a successful same-session resume in the CLI.
- Existing running records are not blindly replayed. Unknown execution/delivery outcomes require local inspection; this is not an exactly-once guarantee for external side effects.
- `/new` preserves files and queued work. It is not a cancellation command.
- Approval decisions are replay-idempotent only for the same authenticated Telegram update. Another click cannot replay consent. Buttons record consent; they do not constrain a full-access executor's tools.
- A broken intake journal fails closed, preserving the file. Polling must not acknowledge work it could not persist. Repair it locally before restarting.

## Deliberate limits

The quiet window is two seconds, bounded by thirty seconds/ten messages. Received album items remain together, including at the cap; arbitrarily late attachments cannot be guaranteed to join an earlier turn.

The local JSON journal retains update-ID deduplication tombstones and failed/cancelled batches. It is not a high-volume multi-tenant queue; retention/compaction and automatic service startup belong to later installation work. Use separate control directories for separate bots. Machine-level isolation and disk power-loss durability are not claimed.
