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
    for name in ['manifest.json', 'result.json', 'prompt.txt', 'stdout.jsonl', 'stderr.txt', 'public-tests.txt', 'hidden-grader.txt']:
        add(directory / name, f'runs/{directory.name}/{name}')
    workspace = (workspaces / directory.name).resolve()
    for name, expected in result['files'].items():
        source = workspace / name
        if not source.resolve().is_relative_to(workspace):
            raise RuntimeError(f'Artifact escapes workspace: {directory.name}/{name}')
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f'Artifact changed after measurement: {directory.name}/{name}')
        add(source, f'runs/{directory.name}/workspace/{name}')
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
