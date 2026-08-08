#!/usr/bin/env python3
"""Cross-harness local agent peer channel with Claude Code compatibility."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
MAX_REGISTRY_BYTES = 256 * 1024
MAX_MESSAGE_BYTES = 64 * 1024
MAX_FRAME_BYTES = 1024 * 1024
MAX_INBOX_BYTES = 10 * 1024 * 1024
SOCKET_PATH_LIMIT = 103


class CliError(Exception):
    def __init__(self, message: str, exit_code: int = 3):
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class Peer:
    name: str
    ref: str
    pid: int | None
    harness: str
    kind: str
    status: str
    socket_path: Path
    compatible: bool = True

    def public(self, address: str) -> dict[str, Any]:
        value = {
            "address": address,
            "compatible": self.compatible,
            "harness": self.harness,
            "kind": self.kind,
            "name": self.name,
            "ref": self.ref,
            "status": self.status,
        }
        if self.pid is not None:
            value["pid"] = self.pid
        return value


def default_runtime_dir() -> Path:
    candidate = os.environ.get("XDG_RUNTIME_DIR")
    if candidate and Path(candidate).is_absolute():
        return Path(candidate) / "agent-peer-channel"
    base = Path(tempfile.gettempdir())
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return base / f"agent-peer-{uid}"


def default_claude_sessions_dir() -> Path:
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(config).expanduser() if config else Path.home() / ".claude") / "sessions"


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise CliError(f"Private runtime path is not a directory: {path}", 4)
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise CliError(f"Private runtime path belongs to another user: {path}", 4)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def exclusive_json(path: Path, payload: dict[str, Any]) -> None:
    """Publish a complete record without ever replacing an existing owner."""
    ensure_private_dir(path.parent)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    try:
        os.link(temporary, path)
    except FileExistsError as error:
        raise CliError(f"Refusing to replace existing Claude registry record {path.name}", 4) from error
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def name_key(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]


def validate_name(name: str) -> str:
    clean = name.strip()
    if not clean or len(clean) > 80 or any(ord(character) < 32 for character in clean):
        raise CliError("Peer name must contain 1-80 printable characters", 2)
    return clean


def require_claude_compatibility() -> None:
    try:
        result = subprocess.run(
            ["claude", "--version"],
            text=True,
            capture_output=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CliError("Claude visibility requires Claude Code 2.1.224 or later", 4) from error
    match = re.search(r"\b(\d+)\.(\d+)\.(\d+)\b", result.stdout + result.stderr)
    if result.returncode != 0 or match is None or tuple(map(int, match.groups())) < (2, 1, 224):
        raise CliError("Claude visibility requires Claude Code 2.1.224 or later", 4)


def owned_path(runtime_dir: Path, name: str) -> Path:
    return runtime_dir / "owned" / f"{name_key(name)}.json"


def load_json(path: Path, maximum: int = MAX_REGISTRY_BYTES) -> dict[str, Any] | None:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            return None
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def validate_socket(path: Path) -> None:
    try:
        metadata = path.stat()
    except OSError as error:
        raise CliError(f"Peer is no longer reachable: {error.strerror or error}") from error
    if not stat.S_ISSOCK(metadata.st_mode):
        raise CliError("Peer registry target is not a Unix socket")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise CliError("Peer socket belongs to another operating-system user")


def probe(path: Path) -> bool:
    try:
        validate_socket(path)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.25)
            client.connect(str(path))
        return True
    except (CliError, OSError):
        return False


def parse_peer(path: Path) -> Peer | None:
    payload = load_json(path)
    if payload is None:
        return None
    protocol = payload.get("protocol")
    is_neutral = isinstance(protocol, str) and protocol.startswith("agent-peer-channel/")
    is_claude = isinstance(payload.get("peerProtocol"), int)
    if not is_neutral and not is_claude:
        return None
    compatible = protocol == "agent-peer-channel/1" if is_neutral else payload.get("peerProtocol") == PROTOCOL_VERSION
    raw_pid = payload.get("pid")
    pid = raw_pid if isinstance(raw_pid, int) else None
    name = payload.get("name")
    session_id = payload.get("instance_id") if is_neutral else payload.get("sessionId")
    raw_endpoint = payload.get("endpoint") if is_neutral else payload.get("messagingSocketPath")
    socket_path = raw_endpoint.removeprefix("uds:") if isinstance(raw_endpoint, str) else None
    if (
        not isinstance(name, str)
        or not name.strip()
        or not isinstance(session_id, str)
        or not isinstance(socket_path, str)
        or not socket_path.startswith("/")
    ):
        return None
    if not is_neutral and pid is None:
        return None
    if is_neutral and isinstance(payload.get("expires_at"), str):
        try:
            expires = datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
        except ValueError:
            return None
        if expires <= datetime.now(timezone.utc):
            return None
    reference = str(payload.get("reference") or re.sub(r"[^A-Za-z0-9]", "", session_id)[:6] or pid or "peer")
    entrypoint = payload.get("entrypoint")
    harness = str(payload.get("harness") or ("generic" if entrypoint == "agent-peer-channel" else "claude"))
    return Peer(
        name=name.strip(),
        ref=reference,
        pid=pid,
        harness=harness,
        kind=str(payload.get("kind") or "unknown"),
        status=str(payload.get("status") or "unknown"),
        socket_path=Path(socket_path),
        compatible=compatible,
    )


def discover(runtime_dir: Path, claude_sessions_dir: Path) -> list[Peer]:
    paths: list[Path] = []
    for directory in (runtime_dir / "peers", claude_sessions_dir):
        try:
            paths.extend(sorted(directory.glob("*.json")))
        except OSError:
            continue
    unique: dict[str, Peer] = {}
    for path in paths:
        peer = parse_peer(path)
        if peer is not None and str(peer.socket_path) not in unique and probe(peer.socket_path):
            unique[str(peer.socket_path)] = peer
    return sorted(unique.values(), key=lambda peer: (peer.name.casefold(), peer.pid or 0))


def addressed(peers: list[Peer]) -> list[tuple[str, Peer]]:
    counts: dict[str, int] = {}
    for peer in peers:
        counts[peer.name] = counts.get(peer.name, 0) + 1
    return [(peer.name if counts[peer.name] == 1 else f"{peer.name} [{peer.ref}]", peer) for peer in peers]


def resolve(target: str, peers: list[Peer]) -> tuple[str, Peer]:
    rows = addressed(peers)
    exact = [(address, peer) for address, peer in rows if address == target]
    if len(exact) == 1:
        if not exact[0][1].compatible:
            raise CliError(f"Peer {target!r} uses an incompatible protocol version")
        return exact[0]
    same_name = [(address, peer) for address, peer in rows if peer.name == target]
    if len(same_name) == 1:
        if not same_name[0][1].compatible:
            raise CliError(f"Peer {target!r} uses an incompatible protocol version")
        return same_name[0]
    if len(same_name) > 1:
        options = "\n".join(f"  {address}" for address, _ in same_name)
        raise CliError(f"Target name is ambiguous. Retry with one of:\n{options}")
    raise CliError(f"Unknown peer {target!r}. Run `list` and use an address it returns.")


def message_text(argument: str | None) -> str:
    value = argument if argument is not None else sys.stdin.read()
    if not value.strip():
        raise CliError("Message must not be empty", 2)
    if len(value.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise CliError(f"Message exceeds the {MAX_MESSAGE_BYTES}-byte safety limit", 2)
    return value


def scrub_close_tag(text: str) -> str:
    return re.sub(r"</(?=cross-session-message(?:[>\s/]|$))", r"<\/", text, flags=re.IGNORECASE)


def wrap_message(text: str, sender_name: str, sender_path: Path) -> str:
    safe_name = sender_name.replace('"', "").replace("<", "").replace(">", "")[:80]
    return (
        f'<cross-session-message from="uds:{sender_path}" from-name="{safe_name}">\n'
        f"{scrub_close_tag(text)}\n"
        "</cross-session-message>"
    )


def make_envelope(
    text: str,
    sender_name: str | None = None,
    sender_path: Path | None = None,
    in_reply_to: str | None = None,
) -> tuple[str, dict[str, Any]]:
    message_id = str(uuid.uuid4())
    content = wrap_message(text, sender_name, sender_path) if sender_name and sender_path else text
    payload: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "msgV": PROTOCOL_VERSION,
        "msg_id": message_id,
        "type": "user",
        "message": {"role": "user", "content": content},
        "priority": "next",
    }
    if sender_path is not None:
        payload["from"] = "uds:" + str(sender_path)
    if sender_name is not None:
        payload["sender"] = sender_name
    if in_reply_to is not None:
        payload["in_reply_to"] = in_reply_to
    return message_id, payload


def transmit(path: Path, payload: dict[str, Any]) -> None:
    validate_socket(path)
    wire = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(str(path))
            client.sendall(wire)
    except OSError as error:
        raise CliError(f"Could not queue message: {error}", 4) from error


def read_frame(connection: socket.socket) -> dict[str, Any] | None:
    data = bytearray()
    while b"\n" not in data:
        chunk = connection.recv(65536)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_FRAME_BYTES:
            raise CliError("Frame exceeded 1 MiB", 4)
    if not data:
        return None
    try:
        value = json.loads(bytes(data).split(b"\n", 1)[0])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CliError("Received an invalid JSON frame", 4) from error
    return value if isinstance(value, dict) else None


WRAPPER = re.compile(
    r'^<cross-session-message\b(?P<attrs>[^>]*)>\n?(?P<body>[\s\S]*?)\n?</cross-session-message>$'
)


def normalize_user_frame(frame: dict[str, Any]) -> dict[str, Any] | None:
    if frame.get("type") != "user":
        return None
    message = frame.get("message")
    if (
        not isinstance(message, dict)
        or message.get("role") != "user"
        or not isinstance(message.get("content"), str)
        or not message["content"].strip()
    ):
        return None
    content = message["content"]
    sender = frame.get("sender") if isinstance(frame.get("sender"), str) else None
    match = WRAPPER.fullmatch(content)
    if match:
        content = match.group("body").replace(r"<\/cross-session-message", "</cross-session-message")
        name_match = re.search(r'\bfrom-name="([^"<>\r\n]+)"', match.group("attrs"))
        if name_match:
            sender = name_match.group(1)
    reply_address = frame.get("from") if isinstance(frame.get("from"), str) else None
    reply_token = None
    if reply_address and reply_address.startswith("uds:"):
        token_payload = {
            "address": reply_address,
            "in_reply_to": frame.get("msg_id") if isinstance(frame.get("msg_id"), str) else None,
        }
        reply_token = "reply:" + base64.urlsafe_b64encode(
            json.dumps(token_payload, separators=(",", ":")).encode()
        ).decode().rstrip("=")
    return {
        "from": sender or "unknown",
        "message": content,
        "message_id": frame.get("msg_id") if isinstance(frame.get("msg_id"), str) else None,
        "in_reply_to": frame.get("in_reply_to") if isinstance(frame.get("in_reply_to"), str) else None,
        "received_at": int(time.time() * 1000),
        "reply_token": reply_token,
    }


def state_for(runtime_dir: Path, name: str, require_live: bool = True) -> dict[str, Any]:
    state = load_json(owned_path(runtime_dir, validate_name(name)))
    if state is None:
        raise CliError(f"No locally announced peer named {name!r}")
    socket_value = state.get("socket")
    if not isinstance(socket_value, str):
        raise CliError(f"Announcement for {name!r} is invalid")
    if require_live and not probe(Path(socket_value)):
        raise CliError(f"Announced peer {name!r} is no longer running")
    return state


def command_start(arguments: argparse.Namespace) -> int:
    name = validate_name(arguments.name)
    harness = validate_name(arguments.harness)
    if arguments.claude_visible:
        require_claude_compatibility()
    ensure_private_dir(arguments.runtime_dir)
    existing = load_json(owned_path(arguments.runtime_dir, name))
    if existing and isinstance(existing.get("socket"), str) and probe(Path(existing["socket"])):
        raise CliError(f"Peer {name!r} is already announced")
    log_dir = arguments.runtime_dir / "logs"
    ensure_private_dir(log_dir)
    log_path = log_dir / f"start-{name_key(name)}.log"
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--runtime-dir",
        str(arguments.runtime_dir),
        "--claude-sessions-dir",
        str(arguments.claude_sessions_dir),
        "_serve",
        "--name",
        name,
        "--cwd",
        str(Path.cwd()),
        "--harness",
        harness,
    ]
    if arguments.claude_visible:
        command.append("--claude-visible")
    with log_path.open("ab") as log:
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
            close_fds=True,
        )
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        state = load_json(owned_path(arguments.runtime_dir, name))
        if state and isinstance(state.get("socket"), str) and probe(Path(state["socket"])):
            print(json.dumps({"ok": True, "name": name, "pid": state["pid"]}))
            return 0
        time.sleep(0.05)
    detail = log_path.read_text(errors="replace")[-1000:] if log_path.exists() else ""
    raise CliError(f"Peer service did not start. {detail}".strip(), 4)


def timestamp(offset_seconds: int = 0) -> str:
    value = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def neutral_manifest(name: str, harness: str, pid: int, peer_id: str, socket_path: Path) -> dict[str, Any]:
    return {
        "protocol": "agent-peer-channel/1",
        "instance_id": peer_id,
        "reference": peer_id.replace("-", "")[:6],
        "pid": pid,
        "name": name,
        "harness": harness,
        "kind": "interactive",
        "status": "idle",
        "endpoint": "uds:" + str(socket_path),
        "started_at": timestamp(),
        "expires_at": timestamp(120),
        "capabilities": ["user", "control", "reply"],
    }


def claude_manifest(name: str, harness: str, pid: int, peer_id: str, socket_path: Path, cwd: str) -> dict[str, Any]:
    now = int(time.time() * 1000)
    return {
        "pid": pid,
        "peerId": peer_id,
        "sessionId": peer_id,
        "cwd": cwd,
        "startedAt": now,
        "updatedAt": now,
        "peerProtocol": PROTOCOL_VERSION,
        "kind": "interactive",
        "status": "idle",
        "entrypoint": "agent-peer-channel",
        "harness": harness,
        "messagingSocketPath": str(socket_path),
        "name": name,
    }


def append_inbox(path: Path, record: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    try:
        if path.stat().st_size >= MAX_INBOX_BYTES:
            return
    except FileNotFoundError:
        pass
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()


def command_serve(arguments: argparse.Namespace) -> int:
    name = validate_name(arguments.name)
    pid = os.getpid()
    peer_id = str(uuid.uuid4())
    token = uuid.uuid4().hex
    socket_dir = arguments.runtime_dir / "s"
    ensure_private_dir(socket_dir)
    socket_path = socket_dir / f"{pid}.sock"
    if len(os.fsencode(socket_path)) > SOCKET_PATH_LIMIT:
        raise CliError("Runtime directory is too long for a Unix socket", 4)
    inbox_path = arguments.runtime_dir / "inbox" / f"{pid}.jsonl"
    neutral_record = arguments.runtime_dir / "peers" / f"{peer_id}.json"
    claude_record = arguments.claude_sessions_dir / f"{pid}.json" if arguments.claude_visible else None
    if claude_record is not None and claude_record.exists():
        raise CliError(f"Refusing to replace existing Claude registry record {claude_record.name}", 4)
    state_path = owned_path(arguments.runtime_dir, name)
    stop = False

    def request_stop(_signal=None, _frame=None):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    if arguments.claude_visible:
        ensure_private_dir(arguments.claude_sessions_dir)
    ensure_private_dir(inbox_path.parent)
    neutral = neutral_manifest(name, arguments.harness, pid, peer_id, socket_path)

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        server.listen()
        server.settimeout(0.25)
        try:
            atomic_json(neutral_record, neutral)
            if claude_record is not None:
                exclusive_json(
                    claude_record,
                    claude_manifest(name, arguments.harness, pid, peer_id, socket_path, arguments.cwd),
                )
            atomic_json(
                state_path,
                {
                    "name": name,
                    "pid": pid,
                    "socket": str(socket_path),
                    "inbox": str(inbox_path),
                    "token": token,
                    "peerId": peer_id,
                    "neutral_record": str(neutral_record),
                    "claude_record": str(claude_record) if claude_record is not None else None,
                },
            )
        except Exception:
            for path in (state_path, neutral_record, socket_path):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
            if claude_record is not None:
                existing = load_json(claude_record)
                if existing and existing.get("entrypoint") == "agent-peer-channel" and existing.get("sessionId") == peer_id:
                    try:
                        claude_record.unlink()
                    except FileNotFoundError:
                        pass
            raise
        refresh_at = time.monotonic() + 30
        try:
            while not stop:
                if time.monotonic() >= refresh_at:
                    neutral["expires_at"] = timestamp(120)
                    atomic_json(neutral_record, neutral)
                    refresh_at = time.monotonic() + 30
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                with connection:
                    connection.settimeout(5)
                    try:
                        frame = read_frame(connection)
                    except (CliError, OSError):
                        continue
                if frame is None:
                    continue
                if frame.get("type") == "control" and frame.get("action") == "agent_peer_stop" and frame.get("token") == token:
                    stop = True
                    continue
                normalized = normalize_user_frame(frame)
                if normalized is not None:
                    append_inbox(inbox_path, normalized)
                elif frame.get("type") == "control":
                    append_inbox(
                        inbox_path,
                        {
                            "control": frame.get("action"),
                            "status": frame.get("status"),
                            "received_at": int(time.time() * 1000),
                        },
                    )
        finally:
            cleanup_paths = [state_path, neutral_record, socket_path]
            if claude_record is not None:
                existing = load_json(claude_record)
                if existing and existing.get("entrypoint") == "agent-peer-channel" and existing.get("sessionId") == peer_id:
                    cleanup_paths.append(claude_record)
            for path in cleanup_paths:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
    return 0


def command_stop(arguments: argparse.Namespace) -> int:
    name = validate_name(arguments.name)
    state = load_json(owned_path(arguments.runtime_dir, name))
    if state is None:
        print(json.dumps({"ok": True, "stopped": name, "already_stopped": True}))
        return 0
    try:
        transmit(
            Path(state["socket"]),
            {"type": "control", "action": "agent_peer_stop", "token": state.get("token")},
        )
    except (CliError, KeyError):
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and owned_path(arguments.runtime_dir, name).exists():
        time.sleep(0.05)
    if owned_path(arguments.runtime_dir, name).exists():
        raise CliError(f"Peer {name!r} did not stop cleanly", 4)
    print(json.dumps({"ok": True, "stopped": name}))
    return 0


def command_list(arguments: argparse.Namespace) -> int:
    rows = [peer.public(address) for address, peer in addressed(discover(arguments.runtime_dir, arguments.claude_sessions_dir))]
    if arguments.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    elif not rows:
        print("No reachable local agent peers.")
    else:
        width = max(len("ADDRESS"), *(len(row["address"]) for row in rows))
        print(f"{'ADDRESS':<{width}}  HARNESS    KIND         STATUS")
        for row in rows:
            rendered_status = row["status"] if row["compatible"] else "incompatible"
            print(f"{row['address']:<{width}}  {row['harness']:<9}  {row['kind']:<11}  {rendered_status}")
    return 0


def sender_identity(arguments: argparse.Namespace) -> tuple[str | None, Path | None]:
    if arguments.sender is None:
        return None, None
    state = state_for(arguments.runtime_dir, arguments.sender)
    return arguments.sender, Path(state["socket"])


def command_send(arguments: argparse.Namespace) -> int:
    text = message_text(arguments.message)
    address, peer = resolve(arguments.to, discover(arguments.runtime_dir, arguments.claude_sessions_dir))
    sender_name, sender_path = sender_identity(arguments)
    message_id, payload = make_envelope(text, sender_name, sender_path)
    transmit(peer.socket_path, payload)
    print(json.dumps({"ok": True, "queued": address, "msg_id": message_id}))
    return 0


def temporary_reply_socket(runtime_dir: Path) -> tuple[socket.socket, Path]:
    socket_dir = runtime_dir / "s"
    ensure_private_dir(socket_dir)
    path = socket_dir / f"q{os.getpid()}-{uuid.uuid4().hex[:5]}.sock"
    if len(os.fsencode(path)) > SOCKET_PATH_LIMIT:
        raise CliError("Runtime directory is too long for a Unix reply socket", 4)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    os.chmod(path, 0o600)
    listener.listen()
    return listener, path


def command_ask(arguments: argparse.Namespace) -> int:
    if arguments.timeout <= 0 or arguments.timeout > 300:
        raise CliError("Ask timeout must be greater than 0 and at most 300 seconds", 2)
    text = message_text(arguments.message)
    address, peer = resolve(arguments.to, discover(arguments.runtime_dir, arguments.claude_sessions_dir))
    listener, reply_path = temporary_reply_socket(arguments.runtime_dir)
    try:
        message_id, payload = make_envelope(text, "agent-peer", reply_path)
        transmit(peer.socket_path, payload)
        deadline = time.monotonic() + arguments.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CliError(f"Timed out after {arguments.timeout:g}s waiting for {address} to reply", 5)
            listener.settimeout(remaining)
            try:
                connection, _ = listener.accept()
            except socket.timeout as error:
                raise CliError(f"Timed out after {arguments.timeout:g}s waiting for {address} to reply", 5) from error
            with connection:
                connection.settimeout(min(5.0, max(0.05, remaining)))
                try:
                    frame = read_frame(connection)
                except socket.timeout:
                    continue
            if frame is None:
                continue
            normalized = normalize_user_frame(frame)
            if normalized is not None:
                if normalized["in_reply_to"] is not None and normalized["in_reply_to"] != message_id:
                    continue
                print(json.dumps({"ok": True, "from": address, "reply": normalized["message"], "msg_id": message_id}, ensure_ascii=False))
                return 0
            if frame.get("type") == "control" and frame.get("status") in {"denied", "expired"}:
                raise CliError(f"Peer reported that the message was {frame['status']}", 4)
    finally:
        listener.close()
        try:
            reply_path.unlink()
        except FileNotFoundError:
            pass


def command_receive(arguments: argparse.Namespace) -> int:
    state = state_for(arguments.runtime_dir, arguments.name)
    inbox = Path(state["inbox"])
    cursor_path = arguments.runtime_dir / "cursor" / f"{name_key(arguments.name)}.txt"
    ensure_private_dir(cursor_path.parent)
    try:
        offset = int(cursor_path.read_text())
    except (OSError, ValueError):
        offset = 0
    deadline = time.monotonic() + arguments.wait
    while True:
        try:
            size = inbox.stat().st_size
        except OSError:
            size = 0
        if size > offset or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    if size < offset:
        offset = 0
    records: list[dict[str, Any]] = []
    if size > offset:
        with inbox.open("rb") as stream:
            stream.seek(offset)
            data = stream.read()
            new_offset = stream.tell()
        for line in data.splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
        cursor_path.write_text(str(new_offset))
    print(json.dumps(records, ensure_ascii=False, indent=2))
    return 0


def decode_reply_token(token: str) -> tuple[Path, str | None]:
    if not token.startswith("reply:"):
        raise CliError("Invalid reply token", 2)
    encoded = token.removeprefix("reply:")
    encoded += "=" * (-len(encoded) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(encoded).decode())
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CliError("Invalid reply token", 2) from error
    if not isinstance(payload, dict):
        raise CliError("Invalid reply token", 2)
    address = payload.get("address")
    if not isinstance(address, str) or not address.startswith("uds:/"):
        raise CliError("Reply token does not name a local peer", 2)
    in_reply_to = payload.get("in_reply_to")
    return Path(address.removeprefix("uds:")), in_reply_to if isinstance(in_reply_to, str) else None


def command_reply(arguments: argparse.Namespace) -> int:
    target, in_reply_to = decode_reply_token(arguments.token)
    sender_name, sender_path = sender_identity(arguments)
    message_id, payload = make_envelope(
        message_text(arguments.message), sender_name, sender_path, in_reply_to
    )
    transmit(target, payload)
    print(json.dumps({"ok": True, "replied": True, "msg_id": message_id}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--runtime-dir", type=Path, default=default_runtime_dir(), help=argparse.SUPPRESS)
    root.add_argument("--claude-sessions-dir", type=Path, default=default_claude_sessions_dir(), help=argparse.SUPPRESS)
    commands = root.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start", help="announce a named inbox in the background")
    start.add_argument("--name", required=True)
    start.add_argument("--harness", default="generic")
    start.add_argument("--claude-visible", action="store_true", help="publish an owned Claude compatibility record")
    start.set_defaults(run=command_start)

    stop = commands.add_parser("stop", help="remove a local announcement")
    stop.add_argument("--name", required=True)
    stop.set_defaults(run=command_stop)

    listing = commands.add_parser("list", help="list reachable peers")
    listing.add_argument("--json", action="store_true")
    listing.set_defaults(run=command_list)

    send = commands.add_parser("send", help="queue a message")
    send.add_argument("--to", required=True)
    send.add_argument("--from", dest="sender")
    send.add_argument("--message")
    send.set_defaults(run=command_send)

    ask = commands.add_parser("ask", help="send and wait for an explicit reply")
    ask.add_argument("--to", required=True)
    ask.add_argument("--message")
    ask.add_argument("--timeout", type=float, default=30.0)
    ask.set_defaults(run=command_ask)

    receive = commands.add_parser("receive", help="read unread messages for an announced peer")
    receive.add_argument("--name", required=True)
    receive.add_argument("--wait", type=float, default=0.0)
    receive.set_defaults(run=command_receive)

    reply = commands.add_parser("reply", help="reply using an opaque token returned by receive")
    reply.add_argument("--token", required=True)
    reply.add_argument("--from", dest="sender")
    reply.add_argument("--message")
    reply.set_defaults(run=command_reply)

    serve = commands.add_parser("_serve", help=argparse.SUPPRESS)
    serve.add_argument("--name", required=True)
    serve.add_argument("--cwd", required=True)
    serve.add_argument("--harness", required=True)
    serve.add_argument("--claude-visible", action="store_true")
    serve.set_defaults(run=command_serve)
    return root


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        return arguments.run(arguments)
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return error.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
