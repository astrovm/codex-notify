# codex-notify

Send one notification when a Codex turn ends. Supports Linux, macOS, [ntfy](https://ntfy.sh/), and [Telegram bots](https://core.telegram.org/bots/tutorial).

The notification is deliberately generic. Prompt text, assistant responses, file names, repository names, and working directories are never sent.

## Requirements

- Codex with the `notify` hook
- [Bun 1.4.0](https://bun.sh/docs/installation) or later to install, build, and test
- Linux or macOS

The installer compiles the TypeScript application into one native executable. Bun is not required when Codex runs the installed hook.

## Install

Run the portable installer:

```sh
./install.sh
```

It installs into `~/.local/bin`, creates a private example configuration if one does not exist, and prints the `notify` line to add to Codex. It never changes `~/.codex/config.toml` automatically.

To build and install manually:

```sh
git clone https://github.com/astrovm/codex-notify.git
cd codex-notify
bun install --frozen-lockfile
bun run build
mkdir -p "$HOME/.local/bin"
install -m700 dist/codex-notify "$HOME/.local/bin/codex-notify"
install -m600 codex-notify-active-window.js "$HOME/.local/bin/codex-notify-active-window.js"
```

Add the hook to `~/.codex/config.toml`:

```toml
notify = ["/absolute/path/to/.local/bin/codex-notify"]
```

Codex adds one JSON event argument to this command. The notifier only handles `agent-turn-complete` events.

## Configure

The private configuration file is stored at:

- Linux: `~/.config/codex-notify/config.json`
- macOS: `~/Library/Application Support/codex-notify/config.json`

Copy `config.example.json`, remove any destination you do not want, and set permissions to `600`:

```sh
chmod 600 /path/to/config.json
```

Validate it without sending a notification:

```sh
codex-notify --check
```

Then send one generic test message to every configured destination:

```sh
codex-notify --test
```

Check platform integration without reading notification secrets or sending anything:

```sh
codex-notify --diagnose
```

The diagnostic checks completion storage, platform integration, proxy indicators, and non-publishing destination connectivity. It reports safe failure phases and codes without printing URLs, topics, tokens, chat IDs, or response bodies.

### ntfy

Use a long, random topic name because anyone who knows a public ntfy topic can subscribe to it. For stronger privacy, use a self-hosted server with access controls.

```json
{
  "destinations": [
    {
      "type": "ntfy",
      "url": "https://ntfy.sh/REPLACE_WITH_A_PRIVATE_TOPIC"
    }
  ]
}
```

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Send a message to the new bot from the destination account or group.
3. Obtain the numeric chat ID, then configure the bot token and chat ID.

```json
{
  "destinations": [
    {
      "type": "telegram",
      "bot_token": "REPLACE_WITH_YOUR_BOT_TOKEN",
      "chat_id": "123456789"
    }
  ]
}
```

The bot token is a secret. Do not commit the real configuration file. Revoke the token with BotFather if it is exposed.

You can include both destination objects to send through ntfy and Telegram.

## Delivery and duplicate prevention

The hook writes one private request and starts a detached per-turn worker. The hook then exits so Codex can finish recording the turn. There is no daemon or platform service.

Codex can invoke a notification hook more than once for the same event. This project creates an atomic marker for each `(thread-id, turn-id, destination)` tuple. Concurrent callbacks therefore send only once to each configured destination.

When `~/.codex/thread_history_1.sqlite` exists, the worker waits for the exact turn row and requires it to reach a terminal status. If the row does not appear within two seconds, the worker treats the hook event as untracked and does not notify. This prevents internal hook events from producing premature notifications. The completed hook event is used only when the database does not exist. The same per-turn deduplication applies to both delivery paths.

Persistent marker files contain hashed event and destination identifiers plus delivery outcomes. A temporary private worker request contains the Codex thread ID, turn ID, and terminal status; it is deleted after successful delivery, presence suppression, or classification as an untracked hook event.

Private `0600` diagnostic files record only safe fields: worker outcome, destination type, attempt count, delivery phase, error code or name, and HTTP status. State and diagnostic files never contain prompts, responses, destination URLs, topics, bot tokens, chat IDs, or HTTP response bodies.

## Presence suppression

Presence suppression is enabled by default. It skips remote notifications only when all three conditions are confirmed after completion:

1. New keyboard or mouse activity occurs during the grace period.
2. The session is unlocked.
3. Codex or ChatGPT is the active application.

The worker always observes the full grace period when input activity is unavailable. After the grace period, it also suppresses an older completed turn when SQLite shows that a newer turn has started in the same thread. The newer turn can then notify when it finishes.

```json
{
  "destinations": [
    { "type": "ntfy", "url": "https://ntfy.sh/REPLACE_WITH_A_PRIVATE_TOPIC" }
  ],
  "presence": {
    "enabled": true,
    "grace_seconds": 8
  }
}
```

To disable presence suppression, set `"presence": { "enabled": false }` in the configuration.

On macOS this uses Core Graphics, `ioreg`, and `lsappinfo`. It does not read key values or mouse coordinates.

On Linux, input activity uses read-only access to `/dev/input/event*`; active-window detection currently supports KDE Plasma Wayland through KWin. Do not add a user to the `input` group without understanding that it grants access to input events from the entire session. If any presence condition cannot be confirmed, the notification is sent.

## Test

```sh
bun install --frozen-lockfile
bun run audit
bun run typecheck
bun test
bun run build
```

## Privacy and security

- The configuration must have mode `600` or stricter.
- Secrets are not included in process arguments or state files.
- Notification messages contain only a generic completion status.
- Delivery still reveals metadata such as your IP address and notification time to the selected service.
- Telegram bots do not use end-to-end encryption.

## License

MIT
