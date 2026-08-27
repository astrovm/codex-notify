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
else
    configuration_directory=${XDG_CONFIG_HOME:-${HOME}/.config}/codex-notify
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

printf '\nInstalled %s\n' "$binary_directory/codex-notify"
printf 'Add this line to %s/.codex/config.toml:\n\n' "$HOME"
printf 'notify = ["%s/codex-notify"]\n' "$binary_directory"
