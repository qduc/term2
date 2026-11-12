"""Prepare an owned full historical repository, with no upstream solution history."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import time

controller = Path(__file__).resolve().parents[3]
workspace = Path(sys.argv[1]).resolve()
if workspace.exists():
    raise RuntimeError('Refuse to overwrite an existing task workspace')
workspace.mkdir(parents=True)
started = time.monotonic()
with tarfile.open(controller / '.handoff/task-source.tar') as archive:
    archive.extractall(workspace, filter='data')
env = dict(os.environ)
for key in list(env):
    if key.endswith(('_API_KEY', '_TOKEN', '_SECRET')):
        env.pop(key)
for args in [
    ['git', 'init', '-q', '-b', 'benchmark'],
    ['git', 'add', '--force', '--all'],
    ['git', '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@invalid', 'commit', '-q', '-m', 'Historical task snapshot'],
    ['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'],
    ['pnpm', 'install', '--frozen-lockfile', '--store-dir', '/workspace/.pnpm-store'],
]:
    result = subprocess.run(args, cwd=workspace, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    if result.returncode:
        sys.stderr.buffer.write(result.stdout[-5000:])
        raise RuntimeError('Repository preparation failed')
files = {}
with tarfile.open(controller / '.handoff/task-source.tar') as archive:
    for member in archive:
        if member.isfile():
            files[member.name] = hashlib.sha256((workspace / member.name).read_bytes()).hexdigest()
print(json.dumps({'workspace': str(workspace), 'baseCommit': 'c5f0002c3f086d3a7daf99c62fbcd5c6bbf6a3f8', 'initialFiles': files, 'setupElapsedMs': round((time.monotonic()-started)*1000)}))
