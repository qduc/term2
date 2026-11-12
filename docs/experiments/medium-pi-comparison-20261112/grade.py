"""Grade actual candidate source with frozen HTTP contracts and no provider credentials."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time

repo = Path(__file__).resolve().parents[3]
candidate, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
grade_root = output / 'grading-copy'
grade_root.mkdir()
with tarfile.open(repo / '.handoff/task-source.tar') as archive:
    archive.extractall(grade_root, filter='data')
shutil.rmtree(grade_root / 'src')
for file in (candidate / 'src').rglob('*'):
    if file.is_symlink():
        raise RuntimeError('Candidate src symlink requires manual review')
shutil.copytree(candidate / 'src', grade_root / 'src')
for name in ['package.json', 'pnpm-lock.yaml', 'scripts/complexity-budget.json']:
    shutil.copyfile(candidate / name, grade_root / name)
shutil.rmtree(grade_root / 'scripts/provider-black-box')
shutil.copytree(repo / '.handoff/grading-source/provider-black-box', grade_root / 'scripts/provider-black-box')
(grade_root / 'node_modules').mkdir()
private = grade_root / '.handoff/acceptance'
private.mkdir(parents=True)
(private / 'vitest.config.mjs').write_text('export default ' + json.dumps({'root': str(grade_root), 'cacheDir': str(private / 'cache'), 'test': {'include': ['scripts/provider-black-box/provider-contract.test.ts'], 'environment': 'node', 'testTimeout': 8000, 'hookTimeout': 4000, 'maxWorkers': 1, 'fileParallelism': False}}))
env = dict(os.environ)
for key in list(env):
    if key.endswith(('_API_KEY', '_TOKEN', '_SECRET')) or key.startswith(('BENCH_', 'AGENT_')) or key in ['OPENAI_BASE_URL', 'NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']:
        env.pop(key)
env.update({'pnpm_config_pm_on_fail': 'ignore', 'NODE_ENV': 'test', 'NODE_USE_ENV_PROXY': '0', 'NO_COLOR': '1', 'TMPDIR': str(private), 'XDG_STATE_HOME': str(private / 'state'), 'XDG_DATA_HOME': str(private / 'data'), 'XDG_CACHE_HOME': str(private / 'cache')})
isolation = ['bwrap', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/', '--bind', str(grade_root), str(grade_root), '--ro-bind', str(candidate / 'node_modules'), str(grade_root / 'node_modules'), '--proc', '/proc', '--dev', '/dev', '--die-with-parent']
node = shutil.which('node')


def execute(label, args, timeout=120):
    start = time.monotonic()
    try:
        p = subprocess.run(isolation + args, cwd=grade_root, env=env, capture_output=True, text=True, timeout=timeout)
        result = {'exitCode': p.returncode, 'elapsedMs': round((time.monotonic()-start)*1000), 'timeout': False}
        text = p.stdout + p.stderr
    except subprocess.TimeoutExpired as error:
        result = {'exitCode': None, 'elapsedMs': round((time.monotonic()-start)*1000), 'timeout': True}
        text = str(error)
    (output / (label + '.txt')).write_text(text)
    return result


typecheck = execute('typecheck', [node, str(grade_root / 'node_modules/typescript-7/bin/tsc'), '--noEmit', '--project', str(grade_root / 'tsconfig.json')])
contracts_file = private / 'contracts.json'
contracts = execute('contracts', [node, str(grade_root / 'node_modules/vitest/vitest.mjs'), 'run', '--config', str(private / 'vitest.config.mjs'), '--configLoader', 'runner', '--reporter=json', '--outputFile', str(contracts_file)])
contract_data = json.loads(contracts_file.read_text()) if contracts_file.exists() else None
if contract_data:
    shutil.copyfile(contracts_file, output / 'contracts.json')
supplement_file = private / 'supplement.json'
loader = grade_root / 'node_modules/tsx/dist/loader.mjs'
supplement = execute('supplement', [node, '--import', str(loader), str(repo / '.handoff/verifier/openrouter-supplement.mjs'), str(grade_root), str(supplement_file), str(candidate)])
supplement_data = json.loads(supplement_file.read_text()) if supplement_file.exists() else None
if supplement_data:
    shutil.copyfile(supplement_file, output / 'supplement.json')
base_package = json.loads((Path('/workspace/term2/.worktrees/medium-task-base') / 'package.json').read_text())
expected_package = json.loads(json.dumps(base_package))
expected_package['dependencies'].pop('@openrouter/ai-sdk-provider')
manifest_scope = json.loads((candidate / 'package.json').read_text()) == expected_package
# Package-manager version bootstrapping needs the registry even with --offline.
# Validate the dependency lock locally without changing the candidate manifest.
lock_manifest = json.loads((grade_root / 'package.json').read_text())
lock_manifest.pop('devEngines', None)
(grade_root / 'package.json').write_text(json.dumps(lock_manifest))
lock = execute('lockfile', [node, '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.cjs', '--pm-on-fail=ignore', '--fetch-retries=0', '--fetch-timeout=1000', 'install', '--lockfile-only', '--trust-lockfile', '--frozen-lockfile', '--ignore-scripts', '--offline', '--store-dir', str(private / 'pnpm-store')])
prepared = output / 'prepared.json'
integrity = []
if prepared.exists():
    initial = json.loads(prepared.read_text())['initialFiles']
    for name, expected in initial.items():
        if name == 'AGENTS.md' or name.startswith('.agents/') or name in ['scripts/rule-baseline.json', 'scripts/complexity-budget.json', 'tsconfig.json', 'tsconfig.build.json', 'scripts/layer-allowlist.json', 'scripts/reachability-allowlist.json', 'scripts/root-allowlist.json']:
            file = candidate / name
            if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
                if name != 'scripts/complexity-budget.json' or not file.is_file() or file.read_bytes() != (Path('/workspace/term2/.worktrees/medium-task-reference') / name).read_bytes():
                    integrity.append(name)
guards = {name: execute(name, [node, 'scripts/' + name + '.mjs']) for name in ['check-layers', 'check-complexity', 'check-rules']}
checks = {'guards': all(x['exitCode'] == 0 for x in guards.values()), 'typecheck': typecheck['exitCode'] == 0, 'frozenHttpContracts': bool(contract_data and contract_data.get('success')), 'supplementalContracts': bool(supplement_data and supplement_data['passed'] == supplement_data['total']), 'dependencyScope': manifest_scope, 'frozenLockfile': lock['exitCode'] == 0, 'instructionsAndGuardsUnchanged': not integrity}
grade = {'pass': all(checks.values()), 'checks': checks, 'typecheck': typecheck, 'contracts': contracts, 'contractPassed': contract_data.get('numPassedTests', 0) if contract_data else 0, 'contractTotal': contract_data.get('numTotalTests', 0) if contract_data else 0, 'supplement': supplement, 'supplementPassed': supplement_data.get('passed', 0) if supplement_data else 0, 'supplementTotal': supplement_data.get('total', 15) if supplement_data else 15, 'lockfile': lock, 'guards': guards, 'integrityFailures': integrity, 'externalNetwork': False}
(output / 'grade.json').write_text(json.dumps(grade, indent=2) + '\n')
print(json.dumps(grade))
