#!/bin/sh
set -eu

source_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
binary_directory=${HOME}/.local/bin

if ! command -v bun >/dev/null 2>&1; then
    printf 'Bun 1.4.0 or later is required. See https://bun.sh/docs/installation\n' >&2
    exit 1
fi

mkdir -p "$binary_directory"
bun install --frozen-lockfile --cwd "$source_directory"
bun build "$source_directory/src/codex-notify.ts" --compile --external=usocket --external=x11 --outfile "$binary_directory/codex-notify"
chmod 700 "$binary_directory/codex-notify"
install -m 600 "$source_directory/codex-notify-active-window.js" "$binary_directory/codex-notify-active-window.js"

if [ "$(uname -s)" = "Darwin" ]; then
    configuration_directory=${HOME}/Library/Application\ Support/codex-notify
    state_directory=${HOME}/Library/Application\ Support/codex-notify/state
else
    configuration_directory=${XDG_CONFIG_HOME:-${HOME}/.config}/codex-notify
    state_directory=${XDG_STATE_HOME:-${HOME}/.local/state}/codex-notify
fi

mkdir -p "$configuration_directory"
chmod 700 "$configuration_directory"
if [ ! -e "$configuration_directory/config.json" ]; then
    install -m 600 "$source_directory/config.example.json" "$configuration_directory/config.json"
    printf 'Created %s\n' "$configuration_directory/config.json"
    printf 'Edit its destinations before enabling the hook.\n'
else
    printf 'Kept existing %s\n' "$configuration_directory/config.json"
fi

migration_marker=${state_directory}/.queue-service-v1
if [ ! -e "$migration_marker" ]; then
    archive_directory=${state_directory}/pre-service-backlog
    mkdir -p "$archive_directory"
    chmod 700 "$state_directory" "$archive_directory"
    backlog_count=$(find "$state_directory" -maxdepth 1 -type f -name 'request-*.json' | wc -l)
    if [ "$backlog_count" -gt 0 ]; then
        find "$state_directory" -maxdepth 1 -type f -name 'request-*.json' \
            -exec mv {} "$archive_directory/" \;
        printf 'Archived %s pre-service queue requests in %s\n' "$backlog_count" "$archive_directory"
    fi
    : > "$migration_marker"
    chmod 600 "$migration_marker"
fi

case "$(uname -s)" in
    Linux)
        service_directory=${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user
        mkdir -p "$service_directory"
        install -m 600 "$source_directory/platform/systemd/codex-notify.service" "$service_directory/codex-notify.service"
        if command -v systemctl >/dev/null 2>&1; then
            systemctl --user daemon-reload
            systemctl --user enable codex-notify.service
            systemctl --user restart codex-notify.service
            printf 'Enabled user service codex-notify.service\n'
        else
            printf 'Installed the systemd user service, but systemctl is unavailable.\n' >&2
        fi
        ;;
    Darwin)
        service_directory=${HOME}/Library/LaunchAgents
        service_path=${service_directory}/io.codex.notify.plist
        service_temporary=${service_path}.tmp
        mkdir -p "$service_directory"
        sed "s|__CODEX_NOTIFY_BINARY__|${binary_directory}/codex-notify|g" \
            "$source_directory/platform/launchd/io.codex.notify.plist" > "$service_temporary"
        chmod 600 "$service_temporary"
        mv "$service_temporary" "$service_path"
        launchctl bootout "gui/$(id -u)" "$service_path" >/dev/null 2>&1 || true
        launchctl bootstrap "gui/$(id -u)" "$service_path"
        printf 'Loaded LaunchAgent io.codex.notify\n'
        ;;
esac

printf '\nInstalled %s\n' "$binary_directory/codex-notify"
printf 'Add this line to %s/.codex/config.toml:\n\n' "$HOME"
printf 'notify = ["%s/codex-notify"]\n' "$binary_directory"
