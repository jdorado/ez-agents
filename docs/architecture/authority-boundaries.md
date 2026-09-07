# Authority boundaries

The relay pairs one verified Telegram owner before execution; foreign senders
and groups do not acquire execution rights. Replies use the run-bound source
chat. Plugin events are untrusted content, queued in the same single-writer lane;
subscription permission is not permission to reply or execute incoming demands.

The host CLI runs as the trusted installing user. Its Markdown role, confirmation
tools, environment filtering and private state layout do not create adversarial
OS isolation. The plugin manager has Docker administration access. Container
profile separation does not protect against a hostile host administrator.

See [SECURITY.md](../../SECURITY.md) for the supported security scope and
[Docker runtime](../docker-runtime.md) for the actual process/storage boundary.
