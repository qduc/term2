#!/usr/bin/env python3
"""Reproduce settled native-usage accounting; never calls a provider."""
import argparse
import collections
import datetime
import hashlib
import json
import pathlib
import statistics


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def milliseconds(start, end):
    parse = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    return round((parse(end) - parse(start)).total_seconds() * 1000, 3)


def summarize(root, cohort):
    wire = root / 'wire-live'
    if (wire / 'active.lock').exists():
        raise ValueError('Refuse final analysis while a writer is active')
    ledger = json.loads((wire / 'ledger.json').read_text())
    prior = json.loads((root / 'starting-ledger.json').read_text())
    assert ledger[:len(prior)] == prior, 'Prior ledger entries changed'
    protocol = json.loads((root / 'protocol.json').read_text())
    nanos = 0
    uncertain = 0
    peak = 0
    runs = {}
    seen = set()
    for entry in ledger:
        assert entry['id'] not in seen, 'Duplicate physical request ID'
        seen.add(entry['id'])
        peak = max(peak, nanos / 1e9 + uncertain + entry['reservedUsd'])
        if not entry.get('priced'):
            uncertain += entry['reservedUsd']
            continue
        body = json.loads((wire / (entry['id'] + '-request.json')).read_text())
        events = json.loads((wire / (entry['id'] + '-response.json')).read_text())
        terminal = [e['response'] for e in events if e.get('type') in
                    ('response.completed', 'response.failed', 'response.incomplete')]
        assert len(terminal) == 1
        native = terminal[0]
        usage = native['usage']
        assert usage == entry['usage'] and entry['status'] == 'metered' and entry['httpStatus'] == 200
        details = usage['input_tokens_details']
        read, write = details['cached_tokens'], details['cache_write_tokens']
        fresh = usage['input_tokens'] - read - write
        assert fresh >= 0
        rates = [200, 20, 250, 750] if usage['input_tokens'] > 272000 else [100, 10, 125, 500]
        if body.get('prompt_cache_retention') in ('12h', '24h'):
            rates[2] *= 2
        components = dict(zip(('fresh', 'read', 'write', 'output'),
                              [value * rate for value, rate in zip((fresh, read, write, usage['output_tokens']), rates)]))
        price = sum(components.values())
        assert abs(price / 1e9 - entry['priced']['usd']) < 1e-12
        nanos += price
        if not entry['runId'].startswith(cohort + '-'):
            continue
        row = runs.setdefault(entry['runId'], {
            'runId': entry['runId'], 'requestIds': [], 'input': 0, 'fresh': 0,
            'read': 0, 'write': 0, 'output': 0, 'nanoUsd': 0, 'componentNanoUsd': collections.Counter(),
            'httpMs': 0, 'durationsMs': [], 'largestContext': 0, 'zeroReadContinuations': [],
            'terminalStatuses': [],
        })
        if row['requestIds']:
            assert body.get('previous_response_id') == row['lastResponseId']
            assert body['prompt_cache_key'] == row['cacheKey']
            if not read:
                row['zeroReadContinuations'].append(entry['id'])
        else:
            assert 'previous_response_id' not in body
            normalized = dict(body)
            normalized.pop('prompt_cache_key')
            row.update(initialBodySha256ExcludingKey=digest(normalized), initialRead=read,
                       initialWrite=write, cacheKey=body['prompt_cache_key'])
        row['requestIds'].append(entry['id'])
        for key, value in [('input', usage['input_tokens']), ('fresh', fresh), ('read', read),
                           ('write', write), ('output', usage['output_tokens']), ('nanoUsd', price)]:
            row[key] += value
        duration = milliseconds(entry['startedAt'], entry['finishedAt'])
        row['httpMs'] += duration
        row['durationsMs'].append(duration)
        row['componentNanoUsd'].update(components)
        row['largestContext'] = max(row['largestContext'], read + write)
        row['lastResponseId'] = native['id']
        row['terminalStatuses'].append(native['status'])
        assert entry['requestSha256'] == entry['outgoingBodySha256']
        outgoing, incoming = entry['outgoingHeaders'], entry['incomingHeaders']
        assert 'session-id' not in incoming
        assert outgoing.get('session-id') == (body['prompt_cache_key'] if entry['runId'].endswith('-affinity') else None)
        assert {k: v for k, v in outgoing.items() if k != 'session-id'} == incoming
        assert body['model'] == 'gpt-6-luna' and body['stream'] is True
        assert body['reasoning']['effort'] == 'medium' and body['max_output_tokens'] == 32000
        assert 'store' not in body
    for row in runs.values():
        result = json.loads((root / 'runs' / row['runId'] / 'result.json').read_text())
        assert result['requestIds'] == row['requestIds']
        row.update({key: result.get(key) for key in ['task', 'rep', 'arm', 'qualityPass', 'grade',
                   'agentSkillRead', 'agentPublicTestSuccess', 'requestedUnsandboxedCalls', 'childElapsedMs']})
        row['requests'] = len(row['requestIds'])
        row['usd'] = row['nanoUsd'] / 1e9
        row['writesAboveLargestContext'] = row['write'] - row['largestContext']
        row['medianHttpMs'] = statistics.median(row['durationsMs'])
        row.pop('lastResponseId')
    arms = {}
    metrics = ['requests', 'input', 'fresh', 'read', 'write', 'output', 'nanoUsd', 'httpMs',
               'childElapsedMs', 'writesAboveLargestContext', 'initialRead', 'initialWrite']
    for arm in ('baseline', 'affinity'):
        rows = [r for r in runs.values() if r['arm'] == arm]
        arms[arm] = {'runs': len(rows), **{key: sum(r[key] or 0 for r in rows) for key in metrics},
                     'zeroReadContinuations': sum(len(r['zeroReadContinuations']) for r in rows),
                     'externalQualityPasses': sum(bool(r['qualityPass']) for r in rows),
                     'actualSkillReads': sum(bool(r['agentSkillRead']) for r in rows),
                     'actualPublicTestSuccesses': sum(bool(r['agentPublicTestSuccess']) for r in rows),
                     'requestedUnsandboxedCalls': sum(r['requestedUnsandboxedCalls'] for r in rows),
                     'componentNanoUsd': dict(sum((r['componentNanoUsd'] for r in rows), collections.Counter()))}
        arms[arm]['usd'] = arms[arm]['nanoUsd'] / 1e9
    pairs = []
    for task, rep in sorted({(r['task'], r['rep']) for r in runs.values()}):
        pair = {r['arm']: r for r in runs.values() if r['task'] == task and r['rep'] == rep}
        if len(pair) != 2:
            pairs.append({'task': task, 'rep': rep, 'incomplete': True})
            continue
        baseline, treatment = pair['baseline'], pair['affinity']
        order = [p['arm'] for p in protocol['plannedRuns'] if p['task'] == task and p['rep'] == rep]
        pairs.append({'task': task, 'rep': rep, 'order': order,
                      'initialBodiesEqualExceptKey': baseline['initialBodySha256ExcludingKey'] == treatment['initialBodySha256ExcludingKey'],
                      'treatmentMinusBaseline': {key: treatment[key] - baseline[key] for key in metrics}})
    signs = {}
    for metric in metrics:
        differences = [p['treatmentMinusBaseline'][metric] for p in pairs if not p.get('incomplete')]
        signs[metric] = {'treatmentLower': sum(d < 0 for d in differences),
                         'tie': sum(d == 0 for d in differences), 'treatmentHigher': sum(d > 0 for d in differences)}
    return {'cohort': cohort, 'testedHead': json.loads((root / 'build-receipt.json').read_text())['inputs']['head'],
            'cumulativeRequests': len(ledger), 'cumulativeEstimatedUsd': nanos / 1e9,
            'priorEstimatedUsd': sum(e['priced']['usd'] for e in prior), 'uncertainExposureUsd': uncertain,
            'peakReservedPlusEstimatedUsd': peak, 'cleanRequests': sum(r['requests'] for r in runs.values()),
            'cleanEstimatedUsd': sum(r['nanoUsd'] for r in runs.values()) / 1e9,
            'arms': arms, 'pairs': pairs, 'pairedDirections': signs, 'runs': list(runs.values()),
            'plannedRuns': len(protocol['plannedRuns']), 'finalizedRuns': len(runs),
            'stopped': (root / 'stopped.json').exists() or (wire / 'guardrail-stop.json').exists(),
            'notes': ['All prices are native-usage standard-rate estimates, not invoices',
                      'Historical failed cohort remains in cumulative spend, excluded from clean arm comparison',
                      'HTTP sums differ from wall-clock duration; child duration excludes external grading',
                      'Writes above largest context and fresh input are derived, not native counters or proven savings',
                      'Fixed balanced order; six stochastic task pairs do not establish general equivalence']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--cohort', default='clean-r1')
    args = parser.parse_args()
    print(json.dumps(summarize(args.root, args.cohort), indent=2))
