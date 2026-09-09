# Available plugins

This is Ez's public catalog of released plugins, for business owners and agents
discovering capabilities. Each entry links to the plugin's own repository,
installation instructions and releases. WhatsApp is the only released plugin
listed today.

| Plugin | Capability | Package | Release |
|---|---|---|---|
| [WhatsApp](https://github.com/jdorado/ez-whatsapp) | Link an existing WhatsApp account so the agent can use its messaging tools. Uses WhatsApp Web linked devices through Baileys; requires an account already on a phone. | `@jc_stack/ez-whatsapp` | [0.1.0-beta.12](https://github.com/jdorado/ez-whatsapp/releases/tag/v0.1.0-beta.12) — testing beta |

## Set up a plugin

Finish [Ez setup](setup.md) and verify an actual agent reply in Telegram first.
Then ask that assistant: **“Set up WhatsApp using
https://github.com/jdorado/ez-whatsapp.”** The installed agent follows the plugin's
README, handles package inspection and installation, delivers the linking QR,
and verifies the connected account. The owner completes the phone linking step.
Account setup does not authorize sending messages to other people.

For installing agents: use the exact scoped package and a pinned release from
the linked repository. Read the supplied artifact's documentation and verify its
integrity. Register the inspected local source and revision in this agent's
catalog using the [plugin manager](plugins.md). A repository URL here is a
discovery link, not an executable registration or an automatic install.

The public catalog lists available products. The agent's local catalog records
reviewed package sources and revisions; its registry records installed tools.
The packaged `default-plugins.json` stays empty so initial Ez setup remains
independent of plugins and provider accounts.

## Add a released plugin

Submit a pull request adding its name, concrete capability, canonical repository,
exact package identity, and pinned release link with beta/stable status. Follow
[plugin contribution requirements](plugin-contributions.md). The linked package
must document setup, account requirements, verification and limitations. Keep
unreleased ideas out of this catalog and update release links through reviewed
changes.
