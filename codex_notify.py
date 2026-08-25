#!/usr/bin/env python3
"""Send one private notification for each completed Codex turn."""

import ctypes
import fcntl
import glob
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
import sqlite3
import struct
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
import urllib.request


POLL_SECONDS = 0.25
MAX_WAIT_SECONDS = 24 * 60 * 60
TERMINAL_TURN_STATUSES = {"completed", "failed", "interrupted"}
INPUT_EVENT = struct.Struct("llHHI")
EV_KEY = 0x01
EV_REL = 0x02
EV_ABS = 0x03


class ConfigError(Exception):
    pass


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))


def config_path() -> Path:
    override = os.environ.get("CODEX_NOTIFY_CONFIG")
    if override:
        return Path(override)
    if platform.system() == "Darwin":
        return Path.home() / "Library/Application Support/codex-notify/config.json"
    root = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    return root / "codex-notify/config.json"


def state_directory() -> Path:
    override = os.environ.get("CODEX_NOTIFY_STATE_DIRECTORY")
    if override:
        return Path(override)
    if platform.system() == "Darwin":
        return Path.home() / "Library/Application Support/codex-notify/state"
    root = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    return root / "codex-notify"


def history_database() -> Path:
    override = os.environ.get("CODEX_NOTIFY_HISTORY_DATABASE")
    return Path(override) if override else codex_home() / "thread_history_1.sqlite"


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    selected = path or config_path()
    try:
        mode = selected.stat().st_mode & 0o777
    except OSError as error:
        raise ConfigError("configuration file not found: %s" % selected) from error
    if mode & 0o077:
        raise ConfigError("configuration must not be accessible by group or others: %s" % selected)
    try:
        value = json.loads(selected.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigError("invalid configuration: %s" % selected) from error
    if not isinstance(value, dict):
        raise ConfigError("configuration must be a JSON object")
    destinations = value.get("destinations")
    if not isinstance(destinations, list) or not destinations:
        raise ConfigError("destinations must be a non-empty list")
    for destination in destinations:
        validate_destination(destination)
    presence = value.get("presence", {})
    if not isinstance(presence, dict):
        raise ConfigError("presence must be a JSON object")
    if "enabled" in presence and not isinstance(presence["enabled"], bool):
        raise ConfigError("presence.enabled must be true or false")
    grace = presence.get("grace_seconds", 8)
    if isinstance(grace, bool) or not isinstance(grace, (int, float)) or not 0 <= grace <= 300:
        raise ConfigError("presence.grace_seconds must be a number from 0 to 300")
    return value


def validate_destination(destination: Any) -> None:
    if not isinstance(destination, dict):
        raise ConfigError("each destination must be a JSON object")
    kind = destination.get("type")
    if kind == "ntfy":
        if not isinstance(destination.get("url"), str) or not destination["url"]:
            raise ConfigError("an ntfy destination requires url")
    elif kind == "telegram":
        for field in ("bot_token", "chat_id"):
            if not isinstance(destination.get(field), str) or not destination[field]:
                raise ConfigError("a Telegram destination requires %s" % field)
    else:
        raise ConfigError("unsupported destination type: %r" % kind)


def turn_digest(thread_id: str, turn_id: str) -> str:
    identity = json.dumps([thread_id, turn_id], separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def destination_digest(destination: Dict[str, Any]) -> str:
    encoded = json.dumps(destination, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def read_turn_status(
    thread_id: str,
    turn_id: str,
    database: Optional[Path] = None,
) -> Optional[Tuple[str, Optional[int]]]:
    path = database or history_database()
    if not path.is_file():
        return None
    try:
        with sqlite3.connect("%s?mode=ro" % path.as_uri(), uri=True, timeout=1) as connection:
            row = connection.execute(
                "SELECT status, completed_at FROM thread_turns "
                "WHERE thread_id = ? AND turn_id = ?",
                (thread_id, turn_id),
            ).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return None
    completed_at = int(row[1]) if row[1] is not None else None
    return str(row[0]), completed_at


def is_activity_event(event_type: int, value: int) -> bool:
    if event_type == EV_KEY:
        return value in (1, 2)
    return event_type in (EV_REL, EV_ABS) and value != 0


def linux_activity_after_completion(timeout: float) -> bool:
    selector = selectors.DefaultSelector()
    descriptors = []  # type: List[int]
    try:
        for path in glob.glob("/dev/input/event*"):
            try:
                descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            except OSError:
                continue
            descriptors.append(descriptor)
            selector.register(descriptor, selectors.EVENT_READ)
        if not descriptors:
            return False
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            for key, _ in selector.select(remaining):
                try:
                    data = os.read(key.fd, INPUT_EVENT.size * 64)
                except (BlockingIOError, OSError):
                    continue
                complete = len(data) - (len(data) % INPUT_EVENT.size)
                for offset in range(0, complete, INPUT_EVENT.size):
                    _, _, event_type, _, value = INPUT_EVENT.unpack_from(data, offset)
                    if is_activity_event(event_type, value):
                        return True
    finally:
        selector.close()
        for descriptor in descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass


def linux_session_is_unlocked() -> bool:
    session_id = os.environ.get("XDG_SESSION_ID", "").strip()
    if not session_id:
        try:
            result = subprocess.run(
                ["loginctl", "show-user", str(os.getuid()), "-p", "Display", "--value"],
                check=True,
                capture_output=True,
                text=True,
                timeout=2,
            )
            session_id = result.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return False
    if not session_id:
        return False
    try:
        result = subprocess.run(
            ["loginctl", "show-session", session_id, "-p", "Active", "-p", "LockedHint"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return properties.get("Active") == "yes" and properties.get("LockedHint") == "no"


def query_kde_active_window(script_path: Optional[Path] = None) -> Optional[Dict[str, str]]:
    try:
        import dbus
        import dbus.mainloop.glib
        import dbus.service
        from gi.repository import GLib
    except (ImportError, ValueError):
        return None
    script = script_path or Path(__file__).with_name("codex-notify-active-window.js")
    if not script.is_file():
        return None
    state = state_directory()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = state / "presence.lock"
    with lock_path.open("a", encoding="utf-8") as lock:
        lock_path.chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        bus = dbus.SessionBus()
        try:
            name = dbus.service.BusName("io.codex.Notify.ActiveWindow", bus=bus, do_not_queue=True)
        except dbus.DBusException:
            return None
        answer = {}  # type: Dict[str, str]
        loop = GLib.MainLoop()

        class Receiver(dbus.service.Object):
            @dbus.service.method("io.codex.Notify.ActiveWindow", in_signature="sss", out_signature="")
            def Report(self, resource_class: str, caption: str, pid: str) -> None:
                answer.update(resource_class=str(resource_class), caption=str(caption), pid=str(pid))
                loop.quit()

        receiver = Receiver(bus, "/ActiveWindow")
        plugin_name = "codex-notify-active-window-%s" % os.getpid()
        loaded = False
        try:
            result = subprocess.run(
                ["qdbus6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", str(script), plugin_name],
                check=True,
                capture_output=True,
                text=True,
                timeout=2,
            )
            loaded = int(result.stdout.strip()) >= 0
            if not loaded:
                return None
            subprocess.run(
                ["qdbus6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"],
                check=True,
                capture_output=True,
                timeout=2,
            )
            GLib.timeout_add(2000, lambda: (loop.quit(), False)[1])
            loop.run()
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        finally:
            if loaded:
                subprocess.run(
                    ["qdbus6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", plugin_name],
                    capture_output=True,
                    timeout=2,
                )
            receiver.remove_from_connection()
            del name
    return answer or None


def linux_codex_is_active() -> bool:
    window = query_kde_active_window()
    if window is None:
        return False
    resource_class = window.get("resource_class", "").lower()
    if any(name in resource_class for name in ("codex", "chatgpt", "chat-gpt")):
        return True
    pid = window.get("pid", "")
    if not pid.isdigit():
        return False
    try:
        process_name = Path("/proc/%s/comm" % pid).read_text(encoding="utf-8").strip().lower()
    except OSError:
        return False
    return process_name in {"chatgpt", "codex"}


def mac_idle_seconds() -> Optional[float]:
    try:
        framework = ctypes.CDLL(
            "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
        )
        function = framework.CGEventSourceSecondsSinceLastEventType
        function.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        function.restype = ctypes.c_double
        value = float(function(0, 0xFFFFFFFF))
    except (AttributeError, OSError, ValueError):
        return None
    return value if value >= 0 else None


def mac_session_is_unlocked() -> bool:
    try:
        result = subprocess.run(
            ["ioreg", "-n", "Root", "-d", "1"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return '"IOConsoleLocked" = No' in result.stdout


def mac_codex_is_active() -> bool:
    try:
        front = subprocess.run(
            ["lsappinfo", "front"], check=True, capture_output=True, text=True, timeout=2
        ).stdout.strip()
        info = subprocess.run(
            ["lsappinfo", "info", "-only", "name", front],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.lower()
    except (OSError, subprocess.SubprocessError):
        return False
    return any(name in info for name in ('"chatgpt"', '"codex"'))


def user_acknowledged_completion(grace_seconds: float) -> bool:
    grace = max(0.0, grace_seconds)
    if platform.system() == "Darwin":
        start = time.monotonic()
        time.sleep(grace)
        idle = mac_idle_seconds()
        if idle is None or idle + 0.25 >= time.monotonic() - start:
            return False
        return mac_session_is_unlocked() and mac_codex_is_active()
    if platform.system() == "Linux":
        if not linux_activity_after_completion(grace):
            return False
        time.sleep(0.1)
        return linux_session_is_unlocked() and linux_codex_is_active()
    return False


def notification_text(status: str) -> Tuple[str, str, str]:
    if status == "completed":
        return "Codex task finished", "Codex task finished.", "white_check_mark"
    return "Codex task ended", "Codex task ended: %s." % status, "warning"


def send_destination(
    destination: Dict[str, Any],
    status: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> bool:
    title, body, tags = notification_text(status)
    if destination["type"] == "ntfy":
        request = urllib.request.Request(
            destination["url"],
            data=body.encode("utf-8"),
            headers={"Title": title, "Tags": tags, "Cache": "no"},
            method="POST",
        )
    else:
        url = "https://api.telegram.org/bot%s/sendMessage" % destination["bot_token"]
        payload = json.dumps({"chat_id": destination["chat_id"], "text": "%s\n%s" % (title, body)}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    try:
        with opener(request, timeout=10) as response:
            if destination["type"] == "telegram":
                result = json.loads(response.read().decode("utf-8"))
                return result.get("ok") is True
            response.read()
            return True
    except Exception:
        return False


def write_marker(path: Path, outcome: str) -> None:
    temporary = path.with_name("%s.%s.tmp" % (path.name, os.getpid()))
    descriptor = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, ("%s %s\n" % (outcome, int(time.time()))).encode("utf-8"))
    finally:
        os.close(descriptor)
    os.replace(str(temporary), str(path))


def wait_for_terminal_status(
    thread_id: str,
    turn_id: str,
    fallback_status: str,
    status_reader: Callable[[str, str], Optional[Tuple[str, Optional[int]]]],
    sleep: Callable[[float], None],
    monotonic: Callable[[], float],
    maximum_wait: float,
) -> Optional[str]:
    if not history_database().is_file():
        return fallback_status
    deadline = monotonic() + maximum_wait
    turn = status_reader(thread_id, turn_id)
    while turn is None or turn[0] not in TERMINAL_TURN_STATUSES:
        if monotonic() >= deadline:
            return None
        sleep(POLL_SECONDS)
        turn = status_reader(thread_id, turn_id)
    return turn[0]


def process_turn(
    config: Dict[str, Any],
    thread_id: str,
    turn_id: str,
    fallback_status: str = "completed",
    *,
    status_reader: Callable[[str, str], Optional[Tuple[str, Optional[int]]]] = read_turn_status,
    acknowledgement_checker: Callable[[float], bool] = user_acknowledged_completion,
    sender: Callable[[Dict[str, Any], str], bool] = send_destination,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    maximum_wait: float = MAX_WAIT_SECONDS,
    state: Optional[Path] = None,
) -> str:
    directory = state or state_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    digest = turn_digest(thread_id, turn_id)
    skipped_marker = directory / ("skipped-%s" % digest)
    lock_path = directory / ("worker-%s.lock" % digest)
    with lock_path.open("a", encoding="utf-8") as lock:
        lock_path.chmod(0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return "worker-active"
        if skipped_marker.exists():
            return "duplicate"
        status = wait_for_terminal_status(
            thread_id, turn_id, fallback_status, status_reader, sleep, monotonic, maximum_wait
        )
        if status is None:
            return "timeout"
        presence = config.get("presence", {})
        if presence.get("enabled", False):
            grace = float(presence.get("grace_seconds", 8.0))
            if acknowledgement_checker(grace):
                write_marker(skipped_marker, "present")
                return "skipped-present"
        pending = []
        seen_destinations = set()
        for destination in config["destinations"]:
            destination_id = destination_digest(destination)
            marker = directory / ("sent-%s-%s" % (digest, destination_id))
            if destination_id not in seen_destinations and not marker.exists():
                pending.append((destination, marker))
                seen_destinations.add(destination_id)
        if not pending:
            return "duplicate"
        failures = 0
        for destination, marker in pending:
            if sender(destination, status):
                write_marker(marker, "sent")
            else:
                failures += 1
        return "send-failed" if failures else "sent"


def write_worker_request(thread_id: str, turn_id: str, status: str) -> str:
    directory = state_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    digest = turn_digest(thread_id, turn_id)
    request_path = directory / ("request-%s.json" % digest)
    temporary = request_path.with_name("%s.%s.tmp" % (request_path.name, os.getpid()))
    payload = json.dumps(
        {"thread_id": thread_id, "turn_id": turn_id, "status": status}, separators=(",", ":")
    ).encode("utf-8")
    descriptor = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, payload)
    finally:
        os.close(descriptor)
    os.replace(str(temporary), str(request_path))
    return digest


def read_worker_request(digest: str) -> Optional[Tuple[Path, Dict[str, str]]]:
    request_path = state_directory() / ("request-%s.json" % digest)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not all(isinstance(request.get(key), str) for key in ("thread_id", "turn_id", "status")):
        return None
    return request_path, request


def spawn_worker(thread_id: str, turn_id: str, status: str) -> None:
    digest = write_worker_request(thread_id, turn_id, status)
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--worker", digest],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )


def check_configuration() -> int:
    try:
        config = load_config()
    except ConfigError as error:
        print("codex-notify: %s" % error, file=sys.stderr)
        return 1
    kinds = ", ".join(destination["type"] for destination in config["destinations"])
    print("Configuration OK: %s" % kinds)
    print("Presence suppression: %s" % ("enabled" if config.get("presence", {}).get("enabled") else "disabled"))
    return 0


def send_test_notification() -> int:
    try:
        config = load_config()
    except ConfigError as error:
        print("codex-notify: %s" % error, file=sys.stderr)
        return 1
    failures = 0
    for destination in config["destinations"]:
        if send_destination(destination, "completed"):
            print("Test sent: %s" % destination["type"])
        else:
            print("Test failed: %s" % destination["type"], file=sys.stderr)
            failures += 1
    return 1 if failures else 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--check":
        return check_configuration()
    if len(sys.argv) == 2 and sys.argv[1] == "--test":
        return send_test_notification()
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        loaded = read_worker_request(sys.argv[2])
        if loaded is None:
            return 1
        request_path, request = loaded
        try:
            config = load_config()
        except ConfigError:
            return 1
        outcome = process_turn(
            config, request["thread_id"], request["turn_id"], request["status"]
        )
        if outcome in {"sent", "skipped-present", "duplicate"}:
            try:
                request_path.unlink()
            except FileNotFoundError:
                pass
        return 0 if outcome != "send-failed" else 1
    if len(sys.argv) != 2:
        return 2
    try:
        event = json.loads(sys.argv[1])
    except json.JSONDecodeError:
        return 2
    if event.get("type") != "agent-turn-complete":
        return 0
    thread_id = event.get("thread-id")
    turn_id = event.get("turn-id")
    if not isinstance(thread_id, str) or not isinstance(turn_id, str):
        return 0
    status = event.get("status", "completed")
    if status not in TERMINAL_TURN_STATUSES:
        status = "completed"
    spawn_worker(thread_id, turn_id, status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
