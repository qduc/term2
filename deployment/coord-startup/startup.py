#!/usr/bin/python3
"""One pinned coordinator, then one foreground bridge. No submissions or replay.

run holds a boot-local flock; pane replaces a newly-created shell with the TUI.
The pane claim is single-use, so an uncertain pane-run is never blindly retried.
admin exposes the same boot-scoped runtime to supported term2 control commands.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent

class Refuse(RuntimeError):
    pass

def private_dir(p, create=False):
    p = Path(p)
    if not p.is_absolute():
        raise Refuse('Runtime path must be absolute')
    if create:
        p.mkdir(mode=0o700, exist_ok=True)
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
        raise Refuse('Runtime must be a user-owned, nonsymlink mode-0700 directory')
    return p

def runtime(c):
    # No cross-boot fallback. The full boot UUID is part of every job socket path.
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if str(uuid.UUID(boot)) != boot:
        raise Refuse('Invalid Linux boot identity')
    parent = private_dir(c['runtimeParent'])
    result = private_dir(parent / ('t2-' + boot), create=True)
    if len(os.fsencode(str(result / 'term2-discord/00000000000000000000.sock'))) >= 108:
        raise Refuse('Runtime path too long for Unix sockets')
    return result

def read_json(p):
    return json.loads(Path(p).read_text())

def save(p, data):
    p = Path(p)
    temp = p.with_suffix('.tmp-' + str(os.getpid()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, p)

def start_time(pid):
    try:
        value = Path(f'/proc/{int(pid)}/stat').read_text()
        fields = value[value.rindex(')') + 1:].split()
        # Zombie processes cannot own a usable control server.
        return None if fields[0] == 'Z' else fields[19]
    except FileNotFoundError:
        return None

def alive(owner):
    return start_time(owner['pid']) == owner['startedAt']

def environment(c, rt):
    env = os.environ.copy()
    # Bind only this pair, never the shared Herdr manager or unrelated panes.
    env['XDG_RUNTIME_DIR'] = str(rt)
    env['TERM2_CONVERSATIONS_DIR'] = c['conversations']
    env['PATH'] = c['path']
    env.pop('TERM2_DISCORD_BOT_TOKEN', None)
    env.pop('TERM2_DISCORD_GATEWAY', None)
    return env

def select(c, config):
    p = subprocess.run([c['node'], str(HERE / 'lineage.mjs'), str(config)], capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise Refuse(p.stderr.strip())
    return json.loads(p.stdout)

def herdr(c, *args):
    # Always use the HOME-based local default session, never inherited pane socket.
    env = os.environ.copy()
    for key in list(env):
        if key.startswith('HERDR_'):
            env.pop(key)
    env['PATH'] = c['path']
    p = subprocess.run([c['herdr'], *args], env=env, capture_output=True, text=True, timeout=10)
    if p.returncode:
        raise Refuse('Herdr command failed: ' + ' '.join(args[:2]))
    if args[:2] == ('pane', 'run') and not p.stdout.strip():
        return {}  # Supported Herdr mutation acknowledgement has no stdout.
    try:
        reply = json.loads(p.stdout)
        if 'error' in reply:
            raise Refuse('Herdr API error')
        return reply['result']
    except (ValueError, KeyError) as e:
        raise Refuse('Invalid Herdr reply') from e

def rpc(sock, method, params, index):
    request = {'v': 1, 'id': str(index), 'method': method, 'params': params}
    sock.sendall((json.dumps(request) + '\n').encode())
    data = b''
    while not data.endswith(b'\n'):
        chunk = sock.recv(4096)
        if not chunk or len(data) + len(chunk) > 256 * 1024:
            raise Refuse('Invalid control frame')
        data += chunk
    reply = json.loads(data)
    if reply.get('v') != 1 or reply.get('id') != str(index) or reply.get('ok') is not True:
        raise Refuse('Control request not ready/authorized: ' + method)
    return reply['result']

def ready(c, rt, lineage):
    """Prove the exact live binding's real bridge admission, without sending input."""
    adpath = rt / 'term2/control/coord.json'
    ad = read_json(adpath)
    expected = str(rt / 'term2/control/coord.sock')
    if (ad.get('v') != 1 or ad.get('name') != 'coord' or ad.get('socketPath') != expected or
        ad.get('host') != socket.gethostname() or ad.get('cwd') != c['cwd'] or
        ad.get('discordInput') is not True or ad.get('sessionId') not in lineage['chain'] or not alive(ad)):
        raise Refuse('Coordinator advertisement/binding mismatch')
    for p in (adpath, Path(expected)):
        s = p.lstat()
        if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) & 0o077 or stat.S_ISLNK(s.st_mode):
            raise Refuse('Unsafe control endpoint')
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(2)
        s.connect(expected)
        # Authenticate the kernel peer, not merely a possibly stale json file.
        import struct
        pid, uid, _ = struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if pid != ad['pid'] or uid != os.getuid():
            raise Refuse('Control peer does not own advertisement')
        rpc(s, 'hello', {}, 1)
        session = rpc(s, 'get', {'topic': 'session'}, 2)
        if (session.get('sessionId') != ad['sessionId'] or session.get('pid') != ad['pid'] or
            session.get('startedAt') != ad['startedAt'] or session.get('cwd') != c['cwd'] or
            session.get('host') != ad['host'] or session.get('logPath') != lineage['logPath']):
            raise Refuse('Live coordinator does not match pinned lineage')
        outcome = rpc(s, 'bridge_result', {'sessionId': ad['sessionId'], 'startedAt': ad['startedAt'],
                      'clientRequestId': 'startup_readiness_' + uuid.uuid4().hex}, 3)
        if outcome != {'state': 'missing'}:
            raise Refuse('Unexpected readiness result')
    if read_json(adpath) != ad or not alive(ad):
        raise Refuse('Coordinator changed during readiness check')
    return ad

def no_live_writers(c, lineage):
    # Term2's writer lock is conservative (PID only). Never remove one ourselves.
    for segment in lineage['chain']:
        p = Path(c['conversations']) / (segment + '.lock')
        if not p.exists():
            continue
        data = read_json(p)
        if data.get('host') != socket.gethostname() or not isinstance(data.get('pid'), int):
            raise Refuse('Unverifiable conversation writer lock')
        try:
            os.kill(data['pid'], 0)
        except ProcessLookupError:
            continue
        raise Refuse('Existing conversation writer: do not duplicate coordinator')

def adopt_or_launch(c, config, rt, lineage):
    adpath = rt / 'term2/control/coord.json'
    if adpath.exists():
        ad = read_json(adpath)
        if alive(ad):
            # A live but unready/wrong owner must NEVER cause a new launch.
            return
    receiptpath = rt / 'pane.json'
    if receiptpath.exists():
        receipt = read_json(receiptpath)
        processpath = rt / ('process-' + receipt['generation'] + '.json')
        if not processpath.exists():
            # Includes timed-out resource creation or pane-run. Inspect, do not retry.
            raise Refuse('Ambiguous previous pane launch; inspect boot-local pane receipt')
        owner = read_json(processpath)
        if alive(owner):
            return
        if not (rt / ('claim-' + receipt['generation'])).exists():
            raise Refuse('Missing pane claim; cannot prove previous command is spent')
    no_live_writers(c, lineage)
    generation = uuid.uuid4().hex
    receipt = {'generation': generation, 'stage': 'creating', 'leaf': lineage['leaf']}
    save(receiptpath, receipt)
    created = herdr(c, 'workspace', 'create', '--cwd', c['cwd'], '--label', 'coord-recovery', '--no-focus')
    pane = created['root_pane']['pane_id']
    receipt.update(stage='created', pane=pane, workspace=created['root_pane']['workspace_id'])
    save(receiptpath, receipt)
    # A fresh shell is the only pane into which this candidate ever types.
    end = time.monotonic() + 5
    while True:
        info = herdr(c, 'pane', 'process-info', '--pane', pane)['process_info']
        procs = info['foreground_processes']
        if (info['foreground_process_group_id'] == info['shell_pid'] and len(procs) == 1 and
            procs[0]['pid'] == info['shell_pid'] and procs[0]['cwd'] == c['cwd']):
            break
        if time.monotonic() >= end:
            raise Refuse('New recovery pane is not a verified idle shell')
        time.sleep(.1)
    receipt['stage'] = 'launching'
    save(receiptpath, receipt)
    command = shlex.join(['/usr/bin/python3', str(HERE / 'startup.py'), 'pane', str(config), '--generation', generation])
    # exec prevents a later crash from leaving a command queued in a reused shell.
    herdr(c, 'pane', 'run', pane, 'exec ' + command)

def pane(c, config, rt, generation):
    receipt = read_json(rt / 'pane.json')
    if not generation or receipt['generation'] != generation or receipt['stage'] != 'launching':
        raise Refuse('Obsolete pane command')
    # Exclusive, single-use even if Herdr admission acknowledgement was lost.
    claim = os.open(rt / ('claim-' + generation), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(claim)
    lineage = select(c, config)
    no_live_writers(c, lineage)
    save(rt / ('process-' + generation + '.json'), {'pid': os.getpid(), 'startedAt': start_time(os.getpid())})
    os.chdir(c['cwd'])
    argv = [c['node'], c['coordEntry'], '--resume', lineage['leaf'], '--control-socket=coord', '--discord-input']
    os.execve(c['node'], argv, environment(c, rt))

def stop_bridge(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            # Permit one existing 10s REST deadline plus cleanup, below the unit's
            # 15s outer stop limit. A multi-operation tick can still be killed;
            # preserve its journal for uncertain, never blind-replay recovery.
            child.wait(timeout=12)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()

def run(c, config, rt):
    fd = os.open(rt / 'launcher.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as e:
        os.close(fd)
        raise Refuse('Another launcher already owns this boot runtime') from e
    child = None
    def stopping(_sig, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stopping)
    try:
        # Herdr's systemd active state alone is not readiness.
        deadline = time.monotonic() + c.get('readyTimeout', 60)
        while True:
            try:
                herdr(c, 'pane', 'list')
                break
            except (Refuse, subprocess.TimeoutExpired):
                if time.monotonic() >= deadline:
                    raise Refuse('Herdr did not become ready')
                time.sleep(.2)
        lineage = select(c, config)
        adopt_or_launch(c, config, rt, lineage)
        deadline = time.monotonic() + c.get('readyTimeout', 60)
        while True:
            try:
                lineage = select(c, config)
                binding = ready(c, rt, lineage)
                break
            except (Refuse, OSError, ValueError) as cause:
                if time.monotonic() >= deadline:
                    raise Refuse('Pinned coordinator did not reach Discord admission readiness: ' + str(cause)) from cause
                time.sleep(.2)
        # All checks completed for this SAME live process, no prompt submitted.
        child = subprocess.Popen([c['node'], c['bridgeEntry'], 'discord', c['bridgeConfig']],
                                 cwd=c['cwd'], env=environment(c, rt))
        print('startup: coordinator admission ready; bridge child started', flush=True)
        while child.poll() is None:
            time.sleep(c.get('monitorInterval', 1))
            herdr(c, 'pane', 'list')
            current = ready(c, rt, select(c, config))
            if any(current[k] != binding[k] for k in ('pid', 'startedAt', 'sessionId', 'socketPath')):
                raise Refuse('Coordinator binding replaced; bridge must restart after readiness')
        raise Refuse('Bridge child exited: ' + str(child.returncode))
    finally:
        stop_bridge(child)
        os.close(fd)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    for mode in ('run', 'pane', 'select', 'admin'):
        sub = modes.add_parser(mode)
        sub.add_argument('config', type=Path)
        if mode == 'pane':
            sub.add_argument('--generation', required=True)
        if mode == 'admin':
            sub.add_argument('args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    config = args.config.resolve()
    c = read_json(config)
    for key in ('node', 'coordEntry', 'bridgeEntry', 'bridgeConfig', 'herdr', 'cwd', 'conversations', 'runtimeParent'):
        if not isinstance(c.get(key), str) or not Path(c[key]).is_absolute():
            raise Refuse('Configure an absolute path for ' + key)
    if args.mode == 'select':
        print(json.dumps(select(c, config)))
        return
    rt = runtime(c)
    if args.mode == 'admin':
        os.execve(c['node'], [c['node'], c['coordEntry'], 'control', *args.args], environment(c, rt))
    elif args.mode == 'pane':
        pane(c, config, rt, args.generation)
    else:
        run(c, config, rt)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
    except (Refuse, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print('startup refused:', str(e), file=sys.stderr)
        sys.exit(1)
