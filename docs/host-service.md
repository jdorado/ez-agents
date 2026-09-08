# Host transport startup

Register one service per deployment after initializing its tools. Substitute the
exact absolute paths below. Use the existing authenticated host user and include
its Node 22+, pnpm (or Corepack), Docker and CLI directories in PATH. Resolve the
actual installed launchers first; shell aliases and interactive shell startup
files are not available to services. No bot token goes in these service files.
Docker Compose owns the relay/plugins; this service only runs the host transport.
`ezenciel-agents-setup service` starts only the Docker relay; it does not register
or start this host service.

## Linux

Save `~/.config/systemd/user/ez-family.service` with a unique agent name:

```ini
[Unit]
Description=Ez family host CLI transport

[Service]
Type=simple
Environment=EZ_DEPLOYMENT_DIR=/absolute/private/agents/family
Environment=PATH=/absolute/node/bin:/absolute/package-manager/bin:/absolute/cli/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/absolute/ez-package/package/bin/ezenciel-agents-host
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now ez-family.service
systemctl --user status ez-family.service
journalctl --user -u ez-family.service -n 50 --no-pager
```

Startup before login additionally needs administrator-enabled user lingering
(`loginctl enable-linger <host-user>`); verify `loginctl show-user <host-user> -p
Linger`. Docker must start at boot too. Verify the real CLI tool call under this
service environment. Stop/disable only this unit when removing this agent.

## macOS

Save `~/Library/LaunchAgents/local.ez.family.plist` with a unique agent label:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>local.ez.family</string>
<key>ProgramArguments</key><array><string>/absolute/ez-package/package/bin/ezenciel-agents-host</string></array>
<key>EnvironmentVariables</key><dict>
<key>EZ_DEPLOYMENT_DIR</key><string>/absolute/private/agents/family</string>
<key>PATH</key><string>/absolute/node/bin:/absolute/package-manager/bin:/absolute/cli/bin:/usr/local/bin:/usr/bin:/bin</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
```

```sh
plutil -lint "$HOME/Library/LaunchAgents/local.ez.family.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.ez.family.plist"
launchctl print "gui/$(id -u)/local.ez.family"
```

LaunchAgents start at login, not before login. Configure Docker's normal login
startup and verify after reboot/login. Use `launchctl bootout` with the same
domain/file before replacing/removing this service. Never start a duplicate
transport for a deployment. A service listing is insufficient: check heartbeat,
Compose health and an actual Telegram reply.

Linux and macOS are documented host paths. Windows and GUI executor acceptance
are not certified by these instructions or the headless Docker tests.

## Agent-owned upgrades

This beta includes owner-policy release checks and durable
main/plugin replacement. See [upgrade setup, tools and recovery](upgrades.md). Earlier main upgrade/rollback VM QA passed; final-release fresh-host/reboot and live plugin upgrade acceptance remain pending.
