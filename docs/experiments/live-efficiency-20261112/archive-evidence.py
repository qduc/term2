"""Archive synthetic-task evidence only; exclude client state and credentials."""
from pathlib import Path
import hashlib
import json
import os
import re
import sys
import zipfile

campaign = Path(sys.argv[1] if len(sys.argv) > 1 else '.handoff/live-campaign').resolve()
output = Path(sys.argv[2] if len(sys.argv) > 2 else 'docs/experiments/live-efficiency-20261112/evidence.zip')
workspaces = Path('/workspace/scratch/term2-pi-workspaces')
handoff = campaign.parent
entries = {}
baseline = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
if (campaign / 'wire-live/active.lock').exists():
    raise RuntimeError('Live coordinator still holds ledger lock; export only settled evidence')
if baseline:
    # Preserve the already-published historical receipt/lockfiles and exact
    # evidence bytes. Current native captures supersede the shared ledger only.
    with zipfile.ZipFile(baseline) as archive:
        recorded = json.loads(archive.read('manifest.json'))
        for name, expected in recorded.items():
            data = archive.read(name)
            if hashlib.sha256(data).hexdigest() != expected['sha256']:
                raise RuntimeError(f'Historical archive hash mismatch: {name}')
            if name.startswith('wire-live/') and name != 'wire-live/ledger.json':
                # Immutable native exchanges are present in the shared directory.
                current = campaign / name
                if not current.is_file() or current.read_bytes() != data:
                    raise RuntimeError(f'Historical native capture changed: {name}')
                continue
            entries['historical/' + name] = data
        entries['historical/original-manifest.json'] = archive.read('manifest.json')


def add(source, target):
    source = Path(source)
    if source.is_file():
        entries[target] = source.read_bytes()


for name in ['protocol.json', 'summary.json', 'frozen-source-hashes.json', 'frozen-harness.zip', 'build-identity.json']:
    add(campaign / name, 'metadata/' + name)
add('/workspace/scratch/pi-comparison/package.json', 'runtime/pi/package.json')
add('/workspace/scratch/pi-comparison/package-lock.json', 'runtime/pi/package-lock.json')
repo = Path(__file__).resolve().parents[3]
add(repo / 'package.json', 'runtime/term2/package.json')
add(repo / 'pnpm-lock.yaml', 'runtime/term2/pnpm-lock.yaml')
add(repo / 'dist/.term2-build-provenance.json', 'runtime/term2/build-provenance.json')
for source in sorted((campaign / 'wire-live').glob('*.json')):
    add(source, 'wire-live/' + source.name)
for directory in sorted((campaign / 'runs').iterdir()):
    if not (directory / 'result.json').exists():
        continue
    result = json.loads((directory / 'result.json').read_text())
    prefix = 'runs' if result['mode'] == 'live' else 'preflights/current-main/runs'
    for name in ['manifest.json', 'result.json', 'prompt.txt', 'stdout.jsonl', 'stderr.txt', 'public-tests.txt', 'hidden-grader.txt']:
        add(directory / name, f'{prefix}/{directory.name}/{name}')
    workspace = (workspaces / directory.name).resolve()
    for name, expected in result['files'].items():
        source = workspace / name
        if not source.resolve().is_relative_to(workspace):
            raise RuntimeError(f'Artifact escapes workspace: {directory.name}/{name}')
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f'Artifact changed after measurement: {directory.name}/{name}')
        add(source, f'{prefix}/{directory.name}/workspace/{name}')
for source in sorted((campaign / 'wire-fixture').glob('*.json')):
    add(source, 'preflights/current-main/wire-fixture/' + source.name)
for version in ['live-comparison', 'live-comparison-fixture-v2', 'live-comparison-fixture-v3']:
    base = handoff / version
    if not base.exists():
        continue
    for source in sorted((base / 'runs').glob('*/*')):
        if source.name in ['stdout.jsonl', 'stderr.txt', 'manifest.json', 'result.json', 'prompt.txt']:
            add(source, f'preflights/{version}/runs/{source.parent.name}/{source.name}')
    for source in sorted((base / 'wire-fixture').glob('*.json')):
        add(source, f'preflights/{version}/wire-fixture/{source.name}')
for source in sorted((handoff / 'live-verifier').iterdir()):
    if source.suffix in ['.json', '.mjs', '.md']:
        add(source, 'independent-verifier/' + source.name)
for name in ['sandbox-smoke.log', 'sandbox-smoke.mts', 'rejected-client-preload.txt', 'pilot-openai-t2.log', 'pilot-remaining.log', 'campaign-remaining.log']:
    add(handoff / name, 'validation/' + name)

# Native bodies were already sanitized by the gateway. Check known configured
# secret values and token-shaped strings without ever printing their values.
known = [os.environ.get(key, '').encode() for key in ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']]
known = [value for value in known if len(value) >= 12]
pattern = re.compile(rb'(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{30,})')
for name, data in entries.items():
    if any(value in data for value in known) or (not name.endswith('.zip') and pattern.search(data)):
        raise RuntimeError(f'Potential credential in evidence; export stopped: {name}')

manifest = {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in entries.items()}
entries['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in entries.items():
        archive.writestr(name, data)
digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n')
print(json.dumps({'files': len(entries), 'archiveBytes': output.stat().st_size, 'sha256': digest}))
