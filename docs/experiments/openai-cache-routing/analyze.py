#!/usr/bin/env python3
"""Offline diagnostic for the retained PR267 evidence ZIP; never calls a provider."""
import argparse
import hashlib
import json
import zipfile

EXPECTED_SHA256 = '6cbd2f910eb5281154a1a16e3e8a20f26f2e9b15015ccaaa7b81a02cc061c3fd'


def analyze(filename):
    with open(filename, 'rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != EXPECTED_SHA256:
        raise ValueError('Unexpected archive digest; do not substitute another cohort')
    with zipfile.ZipFile(filename) as archive:
        ledger = json.loads(archive.read('wire-live/ledger.json'))
        selected = [e for e in ledger if e.get('runId', '').startswith('current-main-openai-')]
        rows = []
        for run in sorted({e['runId'] for e in selected}):
            entries = [e for e in selected if e['runId'] == run]
            if any(e.get('status') != 'metered' or e.get('priced') is None for e in entries):
                raise ValueError(f'Incomplete usage in {run}')
            bodies = [json.loads(archive.read(f"wire-live/{e['id']}-request.json")) for e in entries]
            writes = sum(e['priced']['cacheWrite'] for e in entries)
            largest = max(e['priced']['cacheRead'] + e['priced']['cacheWrite'] for e in entries)
            rows.append({
                'run': run,
                'requests': len(entries),
                'cacheWrite': writes,
                'largestCachedPlusWrittenContext': largest,
                'writesAboveLargestContext': writes - largest,
                'initialCacheWrite': entries[0]['priced']['cacheWrite'],
                'zeroReadContinuations': [e['id'] for e in entries[1:] if e['priced']['cacheRead'] == 0],
                'stableCacheKey': len({b.get('prompt_cache_key') for b in bodies}) == 1,
                'chainedRequests': sum('previous_response_id' in b for b in bodies),
                'storeFalseRequests': sum(b.get('store') is False for b in bodies),
            })
    totals = {}
    for arm in ('t2', 'pi'):
        arm_rows = [r for r in rows if r['run'].endswith('-' + arm)]
        totals[arm] = {key: sum(r[key] for r in arm_rows) for key in (
            'requests', 'cacheWrite', 'writesAboveLargestContext', 'initialCacheWrite')}
    return {'archiveSha256': digest, 'cohort': 'current-main-openai', 'totals': totals, 'runs': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', help='PR267 live-efficiency evidence.zip')
    args = parser.parse_args()
    print(json.dumps(analyze(args.archive), indent=2))
