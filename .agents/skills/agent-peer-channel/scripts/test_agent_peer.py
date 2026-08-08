#!/usr/bin/env python3

import argparse
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path


SCRIPT = Path(__file__).with_name("agent_peer.py")


class UnixServer:
    def __init__(self, path: Path, handler=None):
        self.path = path
        self.handler = handler or (lambda connection: connection.recv(65536))
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        self.thread.start()
        if not self.ready.wait(timeout=2):
            raise AssertionError("fake Unix server did not start")
        return self

    def __exit__(self, *_args):
        self.stop.set()
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(self.path))
        except OSError:
            pass
        self.thread.join(timeout=2)

    def _run(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(self.path))
            server.listen()
            self.ready.set()
            while not self.stop.is_set():
                connection, _ = server.accept()
                with connection:
                    self.handler(connection)


class AgentPeerCliTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.runtime_dir = self.root / "runtime"
        self.sessions_dir = self.root / "claude-sessions"
        self.sessions_dir.mkdir()
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.claude = self.bin_dir / "claude"
        self.claude.write_text("#!/bin/sh\necho '2.1.224 (Claude Code)'\n")
        self.claude.chmod(0o755)
        self.environment = {**os.environ, "PATH": str(self.bin_dir) + os.pathsep + os.environ.get("PATH", "")}

    def tearDown(self):
        for name in ("codex-test", "codex-visible", "codex-old", "alpha", "beta"):
            self.run_cli("stop", "--name", name)
        self.temp_dir.cleanup()

    def run_cli(self, *arguments, input_text=None, timeout=8):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--runtime-dir",
                str(self.runtime_dir),
                "--claude-sessions-dir",
                str(self.sessions_dir),
                *arguments,
            ],
            input=input_text,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=self.environment,
        )

    def write_claude_session(self, pid, name, session_id, socket_path, status="idle"):
        payload = {
            "pid": pid,
            "sessionId": session_id,
            "name": name,
            "kind": "interactive",
            "status": status,
            "peerProtocol": 1,
            "messagingSocketPath": str(socket_path),
        }
        (self.sessions_dir / f"{pid}.json").write_text(json.dumps(payload))

    def test_start_announces_to_the_neutral_registry_without_mutating_claude_registry(self):
        started = self.run_cli("start", "--name", "codex-test", "--harness", "codex")
        self.assertEqual(started.returncode, 0, started.stderr)

        listed = self.run_cli("list", "--json")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        peers = json.loads(listed.stdout)
        self.assertEqual(peers[0]["name"], "codex-test")
        self.assertEqual(peers[0]["harness"], "codex")
        self.assertNotIn("socket", peers[0])
        self.assertEqual(list(self.sessions_dir.iterdir()), [])

        records = list((self.runtime_dir / "peers").glob("*.json"))
        self.assertEqual(len(records), 1)
        neutral = json.loads(records[0].read_text())
        self.assertEqual(neutral["protocol"], "agent-peer-channel/1")
        self.assertEqual(neutral["harness"], "codex")
        self.assertTrue(neutral["endpoint"].startswith("uds:/"))

    def test_claude_visibility_is_an_explicit_compatibility_option(self):
        started = self.run_cli("start", "--name", "codex-visible", "--claude-visible")
        self.assertEqual(started.returncode, 0, started.stderr)
        start_result = json.loads(started.stdout)

        mirror = self.sessions_dir / f"{start_result['pid']}.json"
        self.assertTrue(mirror.exists())
        mirror_data = json.loads(mirror.read_text())
        self.assertEqual(mirror_data["peerProtocol"], 1)
        self.assertEqual(mirror_data["name"], "codex-visible")
        self.assertEqual(mirror_data["entrypoint"], "agent-peer-channel")

    def test_claude_visibility_rejects_an_unsupported_version(self):
        self.claude.write_text("#!/bin/sh\necho '2.1.223 (Claude Code)'\n")

        result = self.run_cli("start", "--name", "codex-old", "--claude-visible")

        self.assertEqual(result.returncode, 4)
        self.assertIn("2.1.224 or later", result.stderr)

    def test_claude_visibility_refuses_to_replace_an_existing_pid_record(self):
        existing = self.sessions_dir / "777.json"
        existing.write_text('{"ownedBy":"someone-else"}\n')
        spec = importlib.util.spec_from_file_location("agent_peer_under_test", SCRIPT)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        arguments = argparse.Namespace(
            name="collision",
            harness="test",
            cwd=str(self.root),
            runtime_dir=self.runtime_dir,
            claude_sessions_dir=self.sessions_dir,
            claude_visible=True,
        )

        with mock.patch.object(module.os, "getpid", return_value=777):
            with self.assertRaisesRegex(module.CliError, "Refusing to replace"):
                module.command_serve(arguments)
        with self.assertRaisesRegex(module.CliError, "Refusing to replace"):
            module.exclusive_json(existing, {"ownedBy": "agent-peer-channel"})

        self.assertEqual(json.loads(existing.read_text()), {"ownedBy": "someone-else"})

    def test_generic_peer_can_receive_messages(self):
        started = self.run_cli("start", "--name", "codex-test")
        self.assertEqual(started.returncode, 0, started.stderr)

        sent = self.run_cli("send", "--to", "codex-test", "--message", "status please")
        self.assertEqual(sent.returncode, 0, sent.stderr)

        received = self.run_cli("receive", "--name", "codex-test", "--wait", "2")
        self.assertEqual(received.returncode, 0, received.stderr)
        messages = json.loads(received.stdout)
        self.assertEqual(messages[0]["message"], "status please")
        self.assertIsNone(messages[0]["reply_token"])

    def test_generic_peer_replies_with_an_opaque_token(self):
        replies = []

        def capture(connection):
            line = connection.makefile().readline()
            if line:
                replies.append(json.loads(line))

        reply_socket = self.root / "reply.sock"
        with UnixServer(reply_socket, capture):
            started = self.run_cli("start", "--name", "codex-test")
            self.assertEqual(started.returncode, 0, started.stderr)
            peer = json.loads(self.run_cli("list", "--json").stdout)[0]
            state_files = list((self.runtime_dir / "owned").glob("*.json"))
            state = json.loads(state_files[0].read_text())
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(state["socket"])
                envelope = {
                    "type": "user",
                    "message": {"role": "user", "content": "ping"},
                    "from": "uds:" + str(reply_socket),
                }
                client.sendall((json.dumps(envelope) + "\n").encode())
            received = self.run_cli("receive", "--name", peer["name"], "--wait", "2")
            token = json.loads(received.stdout)[0]["reply_token"]
            result = self.run_cli("reply", "--token", token, "--message", "pong")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(replies[0]["message"]["content"], "pong")

    def test_two_generic_harnesses_exchange_and_reply(self):
        for name, harness in (("alpha", "codex"), ("beta", "term2")):
            started = self.run_cli("start", "--name", name, "--harness", harness)
            self.assertEqual(started.returncode, 0, started.stderr)

        sent = self.run_cli("send", "--from", "alpha", "--to", "beta", "--message", "ping")
        self.assertEqual(sent.returncode, 0, sent.stderr)
        beta_message = json.loads(self.run_cli("receive", "--name", "beta", "--wait", "2").stdout)[0]
        self.assertEqual(beta_message["from"], "alpha")
        self.assertEqual(beta_message["message"], "ping")

        replied = self.run_cli(
            "reply",
            "--from",
            "beta",
            "--token",
            beta_message["reply_token"],
            "--message",
            "pong",
        )
        self.assertEqual(replied.returncode, 0, replied.stderr)
        alpha_message = json.loads(self.run_cli("receive", "--name", "alpha", "--wait", "2").stdout)[0]
        self.assertEqual(alpha_message["from"], "beta")
        self.assertEqual(alpha_message["message"], "pong")

    def test_send_to_claude_uses_one_json_line_and_hides_transport(self):
        received = []

        def capture(connection):
            line = connection.makefile().readline()
            if line:
                received.append(json.loads(line))

        target_socket = self.root / "claude.sock"
        self.write_claude_session(
            301,
            "reviewer",
            "333333cc-0000-0000-0000-000000000000",
            target_socket,
        )
        with UnixServer(target_socket, capture):
            result = self.run_cli("send", "--to", "reviewer", "--message", "check the build")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(received[0]["type"], "user")
        self.assertEqual(received[0]["message"]["content"], "check the build")
        output = json.loads(result.stdout)
        self.assertEqual(output["queued"], "reviewer")
        self.assertNotIn("socket", output)

    def test_duplicate_names_require_the_displayed_reference(self):
        first_socket = self.root / "first.sock"
        second_socket = self.root / "second.sock"
        self.write_claude_session(401, "worker", "111111aa-0000-0000-0000-000000000000", first_socket)
        self.write_claude_session(402, "worker", "222222bb-0000-0000-0000-000000000000", second_socket)

        with UnixServer(first_socket), UnixServer(second_socket):
            ambiguous = self.run_cli("send", "--to", "worker", "--message", "hi")
            selected = self.run_cli("send", "--to", "worker [222222]", "--message", "hi")

        self.assertEqual(ambiguous.returncode, 3)
        self.assertIn("worker [111111]", ambiguous.stderr)
        self.assertIn("worker [222222]", ambiguous.stderr)
        self.assertEqual(selected.returncode, 0, selected.stderr)

    def test_ask_waits_for_an_explicit_reply(self):
        def reply(connection):
            line = connection.makefile().readline()
            if not line:
                return
            envelope = json.loads(line)
            reply_address = envelope["from"].removeprefix("uds:")
            for correlation, content in (("wrong-id", "wrong reply"), (envelope["msg_id"], "tests passed")):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(reply_address)
                    response = {
                        "type": "user",
                        "in_reply_to": correlation,
                        "message": {"role": "user", "content": content},
                    }
                    client.sendall((json.dumps(response) + "\n").encode())

        target_socket = self.root / "ask.sock"
        self.write_claude_session(501, "tester", "555555ee-0000-0000-0000-000000000000", target_socket)
        with UnixServer(target_socket, reply):
            result = self.run_cli(
                "ask", "--to", "tester", "--message", "run tests", "--timeout", "2"
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["reply"], "tests passed")

    def test_ask_deadline_covers_a_stalled_reply_connection(self):
        def stall(connection):
            line = connection.makefile().readline()
            if not line:
                return
            envelope = json.loads(line)
            reply_address = envelope["from"].removeprefix("uds:")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(reply_address)
                time.sleep(0.3)

        target_socket = self.root / "stall.sock"
        self.write_claude_session(502, "staller", "666666ee-0000-0000-0000-000000000000", target_socket)
        with UnixServer(target_socket, stall):
            result = self.run_cli(
                "ask", "--to", "staller", "--message", "reply", "--timeout", "0.1"
            )

        self.assertEqual(result.returncode, 5)
        self.assertIn("Timed out", result.stderr)

    def test_malformed_user_envelopes_are_not_admitted(self):
        started = self.run_cli("start", "--name", "codex-test")
        self.assertEqual(started.returncode, 0, started.stderr)
        state = json.loads(next((self.runtime_dir / "owned").glob("*.json")).read_text())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(state["socket"])
            malformed = {"type": "user", "message": {"role": "system", "content": ""}}
            client.sendall((json.dumps(malformed) + "\n").encode())

        result = self.run_cli("receive", "--name", "codex-test", "--wait", "0.1")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [])

    def test_incompatible_peers_are_listed_but_cannot_be_contacted(self):
        target_socket = self.root / "future.sock"
        peer_dir = self.runtime_dir / "peers"
        peer_dir.mkdir(parents=True)
        record = {
            "protocol": "agent-peer-channel/2",
            "instance_id": "future-instance",
            "reference": "future",
            "name": "future-peer",
            "harness": "future",
            "endpoint": "uds:" + str(target_socket),
            "started_at": "2026-08-08T00:00:00Z",
            "expires_at": "2099-08-08T00:00:00Z",
        }
        (peer_dir / "future-instance.json").write_text(json.dumps(record))
        with UnixServer(target_socket):
            peers = json.loads(self.run_cli("list", "--json").stdout)
            table = self.run_cli("list").stdout
            sent = self.run_cli("send", "--to", "future-peer", "--message", "hello")

        self.assertFalse(peers[0]["compatible"])
        self.assertIn("incompatible", table)
        self.assertEqual(sent.returncode, 3)
        self.assertIn("incompatible", sent.stderr)

    def test_stop_removes_the_announcement_and_socket(self):
        started = self.run_cli("start", "--name", "codex-test")
        self.assertEqual(started.returncode, 0, started.stderr)
        pid = json.loads(started.stdout)["pid"]

        stopped = self.run_cli("stop", "--name", "codex-test")
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        for _ in range(20):
            if not (self.sessions_dir / f"{pid}.json").exists():
                break
            time.sleep(0.05)

        self.assertFalse((self.sessions_dir / f"{pid}.json").exists())
        self.assertEqual(json.loads(self.run_cli("list", "--json").stdout), [])

    def test_empty_and_oversized_messages_are_rejected_before_discovery(self):
        empty = self.run_cli("send", "--to", "missing", "--message", "   ")
        oversized = self.run_cli("send", "--to", "missing", "--message", "x" * 65537)

        self.assertEqual(empty.returncode, 2)
        self.assertIn("must not be empty", empty.stderr)
        self.assertEqual(oversized.returncode, 2)
        self.assertIn("65536-byte", oversized.stderr)


if __name__ == "__main__":
    unittest.main()
