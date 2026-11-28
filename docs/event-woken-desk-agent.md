# Isolated desk agent woken by events

An agent that acts only when its owning service has something for it: no polling
model session, no chat prompt. Core adds nothing for this beyond the admin fault
channel below; it composes existing parts.

1. **Create it isolated.** `ezenciel-agents-create --name desk --purpose '...' --isolation isolated < /private/bot-token`
   ([setup](setup.md#create-start-and-verify), [isolation](docker-runtime.md#agent-binding)).
   The native CLI runs in its own relay with only that agent's workspace and
   control mounts. The bot token is the owner chat it briefs.
2. **Install only the plugins it needs** through the plugin manager
   ([plugins](plugins.md)). The agent's only reach outside is its installed
   plugin CLIs; the owning service's plugin is one of them.
3. **Add one standing schedule** every 60 seconds (the minimum) with a read-only
   plugin preflight, `on: eligible`:

   ```sh
   ezenciel-agents-schedule create --name Desk --every-seconds 60 \
     --preflight-file preflight.json --text 'Handle the pending events.'
   ```

   `preflight.json` is
   `{"on":"eligible","checks":[{"alias":"<registered-read-only-command>","args":[]}]}`.
   Core runs the check each tick and starts a session only when the plugin reports
   `eligible: true` ([preflight contract](work-preflight.md)). The plugin returns
   eligible while the owning service holds unacknowledged events or a due
   self-set wake; the run acknowledges them by its own read through the plugin.
   An empty tick creates no run or session. Core never learns what the events are.
4. **One run at a time.** A recurring schedule has at most one pending or active
   occurrence unless `--overlap N` is set ([scheduling](scheduling.md)); leave it
   unset. A run that outlasts the interval simply delays the next tick.
   A run that needs a later wake records it with the owning service's plugin, so the
   preflight reports it eligible when due (or creates a one-off `--at` schedule itself).

## Admin fault channel

A run reports a failed plugin invocation to the operator with
`ezenciel-agents-message --admin --receipt <receipt ID>`. The ID is the relay's
own record of that invocation (printed by `ez` on stderr as `ez receipt: <id>` when a plugin call fails, stored
under `control/plugin-receipts/<run id>/`). The channel is separate from the owner
chat: the relay writes the message itself, from that record and the run ID, and
sends it to a destination only the operator configures:

```text
[ez <agent name>] fault: tool=<plugin command> code=<exit code> class=<status> receipt=<id> run=<run id>
```

There is no caller text at all: no error string, `--text`, `--text-file`,
document, voice or reply-to. A receipt that does not exist for this run, or
records a completed invocation, is refused, so a run cannot send the admin chat
anything the relay did not record, and never the recipient.

Operator configuration: add three lines to the agent's `relay.env` (the private
secret file named by `EZ_RELAY_ENV_FILE`, outside the workspace and control
directories), then recreate the relay while it is idle:

```dotenv
EZ_ADMIN_TELEGRAM_BOT_TOKEN=<ops bot token, a different bot from the owner's>
EZ_ADMIN_TELEGRAM_CHAT_ID=<ops chat ID>
EZ_ADMIN_AGENT_NAME=desk
```

All three or none; a partial set stops the relay at start. The values load into
the relay only and are not in the executor environment. When unset, `--admin`
fails with "Admin fault channel is not configured for this agent" and nothing is
sent anywhere else. Only an active owner-authorized run can use it. The report is
sent as one plain-text Telegram message. A send that fails
reports an error (a network failure or timeout reads "unconfirmed") and core does
not retry it.
