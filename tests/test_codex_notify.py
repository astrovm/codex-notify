import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import codex_notify


class Response:
    def __init__(self, body=b""):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class CodexNotifyTests(unittest.TestCase):
    def test_reads_completed_turn_from_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "history.sqlite"
            with sqlite3.connect(str(database)) as connection:
                connection.execute(
                    "CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, completed_at INTEGER)"
                )
                connection.execute(
                    "INSERT INTO thread_turns VALUES (?, ?, ?, ?)",
                    ("thread-1", "turn-1", "completed", 123),
                )
            self.assertEqual(
                codex_notify.read_turn_status("thread-1", "turn-1", database),
                ("completed", 123),
            )

    def test_sends_each_destination_once(self):
        config = {
            "destinations": [
                {"type": "ntfy", "url": "https://example.invalid/topic"},
                {"type": "telegram", "bot_token": "synthetic-token", "chat_id": "100"},
            ],
            "presence": {"enabled": False},
        }
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            codex_notify, "history_database", return_value=Path(temporary) / "missing.sqlite"
        ):
            sent = []
            sender = lambda destination, status: sent.append((destination["type"], status)) or True
            result = codex_notify.process_turn(
                config, "thread-1", "turn-1", sender=sender, state=Path(temporary)
            )
            duplicate = codex_notify.process_turn(
                config,
                "thread-1",
                "turn-1",
                sender=lambda *_args: self.fail("duplicate notification"),
                state=Path(temporary),
            )
        self.assertEqual(result, "sent")
        self.assertEqual(duplicate, "duplicate")
        self.assertEqual(sent, [("ntfy", "completed"), ("telegram", "completed")])

    def test_retries_only_failed_destination(self):
        destinations = [
            {"type": "ntfy", "url": "https://example.invalid/topic"},
            {"type": "telegram", "bot_token": "synthetic-token", "chat_id": "100"},
        ]
        config = {"destinations": destinations, "presence": {"enabled": False}}
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            codex_notify, "history_database", return_value=Path(temporary) / "missing.sqlite"
        ):
            attempts = []

            def first(destination, _status):
                attempts.append(destination["type"])
                return destination["type"] == "ntfy"

            self.assertEqual(
                codex_notify.process_turn(config, "thread-1", "turn-2", sender=first, state=Path(temporary)),
                "send-failed",
            )
            self.assertEqual(
                codex_notify.process_turn(
                    config,
                    "thread-1",
                    "turn-2",
                    sender=lambda destination, _status: attempts.append(destination["type"]) or True,
                    state=Path(temporary),
                ),
                "sent",
            )
        self.assertEqual(attempts, ["ntfy", "telegram", "telegram"])

    def test_identical_destinations_are_sent_once(self):
        destination = {"type": "ntfy", "url": "https://example.invalid/topic"}
        config = {"destinations": [destination, dict(destination)], "presence": {"enabled": False}}
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            codex_notify, "history_database", return_value=Path(temporary) / "missing.sqlite"
        ):
            sender = mock.Mock(return_value=True)
            result = codex_notify.process_turn(
                config, "thread-1", "turn-identical", sender=sender, state=Path(temporary)
            )
        self.assertEqual(result, "sent")
        sender.assert_called_once()

    def test_presence_suppression_is_opt_in(self):
        config = {
            "destinations": [{"type": "ntfy", "url": "https://example.invalid/topic"}],
            "presence": {"enabled": True, "grace_seconds": 3},
        }
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            codex_notify, "history_database", return_value=Path(temporary) / "missing.sqlite"
        ):
            sender = mock.Mock(return_value=True)
            checker = mock.Mock(return_value=True)
            result = codex_notify.process_turn(
                config,
                "thread-1",
                "turn-present",
                acknowledgement_checker=checker,
                sender=sender,
                state=Path(temporary),
            )
        self.assertEqual(result, "skipped-present")
        checker.assert_called_once_with(3.0)
        sender.assert_not_called()

    def test_builds_ntfy_request_without_message_content(self):
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            return Response()

        destination = {"type": "ntfy", "url": "https://example.invalid/private"}
        self.assertTrue(codex_notify.send_destination(destination, "completed", opener))
        request, timeout = requests[0]
        self.assertEqual(request.full_url, destination["url"])
        self.assertEqual(request.data, b"Codex task finished.")
        self.assertEqual(timeout, 10)

    def test_builds_telegram_request(self):
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            return Response(b'{"ok":true}')

        destination = {"type": "telegram", "bot_token": "synthetic-token", "chat_id": "100"}
        self.assertTrue(codex_notify.send_destination(destination, "completed", opener))
        request, _ = requests[0]
        self.assertEqual(
            request.full_url, "https://api.telegram.org/botsynthetic-token/sendMessage"
        )
        self.assertEqual(json.loads(request.data.decode("utf-8"))["chat_id"], "100")

    def test_rejects_public_configuration_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            path.write_text(
                json.dumps(
                    {"destinations": [{"type": "ntfy", "url": "https://example.invalid/topic"}]}
                ),
                encoding="utf-8",
            )
            os.chmod(str(path), 0o644)
            with self.assertRaises(codex_notify.ConfigError):
                codex_notify.load_config(path)

    def test_rejects_invalid_presence_grace(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "destinations": [
                            {"type": "ntfy", "url": "https://example.invalid/topic"}
                        ],
                        "presence": {"enabled": True, "grace_seconds": "soon"},
                    }
                ),
                encoding="utf-8",
            )
            os.chmod(str(path), 0o600)
            with self.assertRaises(codex_notify.ConfigError):
                codex_notify.load_config(path)

    def test_worker_command_does_not_contain_secrets(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            codex_notify, "state_directory", return_value=Path(temporary)
        ), mock.patch.object(codex_notify.subprocess, "Popen") as popen:
            codex_notify.spawn_worker("thread-1", "turn-1", "completed")
            command = popen.call_args.args[0]
            self.assertNotIn("topic", " ".join(command))
            self.assertNotIn("token", " ".join(command))
            request = next(Path(temporary).glob("request-*.json"))
            self.assertEqual(request.stat().st_mode & 0o777, 0o600)

    def test_test_command_reports_each_destination_without_secrets(self):
        config = {
            "destinations": [
                {"type": "ntfy", "url": "https://example.invalid/private-topic"},
                {"type": "telegram", "bot_token": "synthetic-secret", "chat_id": "100"},
            ]
        }
        with mock.patch.object(codex_notify, "load_config", return_value=config), mock.patch.object(
            codex_notify, "send_destination", return_value=True
        ), mock.patch("builtins.print") as printer:
            self.assertEqual(codex_notify.send_test_notification(), 0)
        output = " ".join(str(call) for call in printer.call_args_list)
        self.assertIn("ntfy", output)
        self.assertIn("telegram", output)
        self.assertNotIn("private-topic", output)
        self.assertNotIn("synthetic-secret", output)

    def test_mac_acknowledgement_requires_new_activity_focus_and_unlock(self):
        with mock.patch.object(codex_notify.platform, "system", return_value="Darwin"), mock.patch.object(
            codex_notify.time, "monotonic", side_effect=[10.0, 18.0]
        ), mock.patch.object(codex_notify.time, "sleep"), mock.patch.object(
            codex_notify, "mac_idle_seconds", return_value=2.0
        ), mock.patch.object(
            codex_notify, "mac_session_is_unlocked", return_value=True
        ), mock.patch.object(
            codex_notify, "mac_codex_is_active", return_value=True
        ):
            self.assertTrue(codex_notify.user_acknowledged_completion(8.0))


if __name__ == "__main__":
    unittest.main()
