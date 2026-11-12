"""Read-only descriptive summary; never calls a provider or repairs a candidate."""
from pathlib import Path
import json
import statistics
import sys

root = Path(sys.argv[1]).resolve()
results = [json.loads(p.read_text()) for p in sorted((root / 'runs').glob('*/result.json'))]
for result in results:
    terminal_assistant = None
    stdout_file = root / 'runs' / result['id'] / 'stdout.jsonl'
    if result['arm'] == 'pi':
        for line in stdout_file.read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get('type') == 'message_end' and event.get('message', {}).get('role') == 'assistant':
                terminal_assistant = event['message']
    result['terminalCliError'] = bool(terminal_assistant and terminal_assistant.get('stopReason') == 'error')
    result['terminalCliErrorMessage'] = terminal_assistant.get('errorMessage') if result['terminalCliError'] else None
    result['acceptedCompletion'] = result['qualityPass'] and not result['terminalCliError']
ledger = json.loads((root / 'wire-live/ledger.json').read_text())
plan_ids = {x['id'] for x in json.loads((root / 'protocol-live.json').read_text())['plan']}
entries = [e for e in ledger if e.get('runId') in plan_ids]
other_medium = [e for e in ledger if e.get('runId', '').startswith('medium-live-') and e.get('runId') not in plan_ids]

retry_lineages = [json.loads(p.read_text()) for p in sorted(root.glob('environment-resume-lineage*.json'))]
retry_parent = {x['newRunId']: x['oldRunId'] for x in retry_lineages}
retry_source_ids = {x['oldRunId'] for x in retry_lineages}
retry_entries = [e for e in ledger if e.get('runId') in retry_source_ids]
retry_usd = sum(e['priced']['usd'] for e in retry_entries if e.get('priced'))
for result in results:
    ancestor_ids = set()
    cursor = result['id']
    while cursor in retry_parent:
        cursor = retry_parent[cursor]
        if cursor in ancestor_ids:
            raise RuntimeError('Invalid retry lineage cycle')
        ancestor_ids.add(cursor)
    prior = [e for e in retry_entries if e.get('runId') in ancestor_ids]
    result['infrastructureRetryMeteredUsd'] = sum(e['priced']['usd'] for e in prior if e.get('priced'))
    result['caseMeteredUsd'] = result['meteredUsd'] + result['infrastructureRetryMeteredUsd']
    result['caseRequests'] = len(result['requestIds']) + len(prior)
    result['caseWallTimeCensored'] = bool(prior) or result['timedOut'] or result['terminalCliError']
    result['wallCensorReasons'] = (['infrastructure_original_wall_unknown'] if prior else []) + (['timeout'] if result['timedOut'] else []) + (['terminal_cli_error'] if result['terminalCliError'] else [])
    result['unresolvedReserveUsd'] = sum(e.get('reservedUsd', 0) for e in entries+prior if e.get('runId') == result['id'] and not e.get('priced'))


def spread(values):
    return {'n': len(values), 'mean': statistics.mean(values), 'median': statistics.median(values), 'min': min(values), 'max': max(values), 'sampleSD': statistics.stdev(values) if len(values) > 1 else None} if values else None


cells = []
for provider in ['openai', 'anthropic']:
    for arm in ['t2', 'pi']:
        rows = [r for r in results if r['provider'] == provider and r['arm'] == arm]
        cells.append({'provider': provider, 'arm': arm, 'completedRuns': len(rows), 'plannedRuns': 5, 'frozenPasses': sum(r['qualityPass'] for r in rows), 'acceptedCompletions': sum(r['acceptedCompletion'] for r in rows), 'terminalCliErrors': sum(r['terminalCliError'] for r in rows), 'caseUsdIncludingInfraRetry': spread([r['caseMeteredUsd'] for r in rows]), 'caseRequestsIncludingInfraRetry': spread([r['caseRequests'] for r in rows]), 'censoredFullCaseWallTimes': sum(r['caseWallTimeCensored'] for r in rows), 'requests': spread([len(r['requestIds']) for r in rows]), 'usd': spread([r['meteredUsd'] for r in rows]), 'agentSeconds': spread([r['agentElapsedMs']/1000 for r in rows]), 'setupSeconds': spread([r['setupElapsedMs']/1000 for r in rows]), 'totalSeconds': spread([r['totalElapsedMs']/1000 for r in rows])})
for cell in cells:
    rows = [r for r in results if r['provider'] == cell['provider'] and r['arm'] == cell['arm']]
    reserve = sum(r['unresolvedReserveUsd'] for r in rows)
    cell['unresolvedReserveUsd'] = reserve
    cell['costSpreadIsKnownUsageLowerBound'] = bool(reserve)
    cell['caseMeanUsdInterval'] = [sum(r['caseMeteredUsd'] for r in rows)/len(rows), (sum(r['caseMeteredUsd'] for r in rows)+reserve)/len(rows)] if rows else None
pairs = []
for provider in ['openai', 'anthropic']:
    rows = []
    for rep in range(1, 6):
        pair = {r['arm']: r for r in results if r['provider'] == provider and r['rep'] == rep}
        if len(pair) != 2:
            continue
        t, p = pair['t2'], pair['pi']
        rows.append({'rep': rep, 't2Pass': t['qualityPass'], 'piPass': p['qualityPass'], 't2AcceptedCompletion': t['acceptedCompletion'], 'piAcceptedCompletion': p['acceptedCompletion'], 'requestsDelta': len(t['requestIds'])-len(p['requestIds']), 'usdDelta': t['meteredUsd']-p['meteredUsd'], 'caseUsdDeltaIncludingInfraRetry': t['caseMeteredUsd']-p['caseMeteredUsd'], 'caseUsdDeltaInterval': [t['caseMeteredUsd']-p['caseMeteredUsd']-p['unresolvedReserveUsd'],t['caseMeteredUsd']+t['unresolvedReserveUsd']-p['caseMeteredUsd']], 'costPointDeltaUsesKnownUsageOnly': bool(t['unresolvedReserveUsd'] or p['unresolvedReserveUsd']), 'caseRequestsDeltaIncludingInfraRetry': t['caseRequests']-p['caseRequests'], 'fullCaseWallTimeCensored': t['caseWallTimeCensored'] or p['caseWallTimeCensored'], 'agentSecondsDelta': (t['agentElapsedMs']-p['agentElapsedMs'])/1000})
    pairs.append({'provider': provider, 'rows': rows, **{k: spread([r[k] for r in rows]) for k in ['requestsDelta', 'usdDelta', 'agentSecondsDelta', 'caseUsdDeltaIncludingInfraRetry', 'caseRequestsDeltaIncludingInfraRetry']}})
report = {'completionStatus': [{k:r[k] for k in ['id','qualityPass','acceptedCompletion','terminalCliError','terminalCliErrorMessage','timedOut','wallCensorReasons','unresolvedReserveUsd']} for r in results], 'completedRuns': len(results), 'plannedRuns': 20, 'cells': cells, 'pairs': pairs, 'infrastructureRetryCases': [{'oldRunId': x['oldRunId'], 'replacementRunId': x['newRunId'], 'replacementCompleted': any(r['id'] == x['newRunId'] for r in results), 'oldWallTime': None, 'priorMeteredUsd': sum(e['priced']['usd'] for e in retry_entries if e.get('runId') == x['oldRunId'] and e.get('priced'))} for x in retry_lineages], 'infrastructureRetryRequests': len(retry_entries), 'infrastructureRetryMeteredUsd': retry_usd, 'fullCaseWallTimeNote': 'Replacement execution wall is measured; interrupted original wall is unknown/censored, not zero.' if retry_entries else None, 'chargedPrimaryCaseRequests': len(entries)+len(retry_entries), 'chargedPrimaryCaseMeteredUsd': sum(e['priced']['usd'] for e in entries+retry_entries if e.get('priced')), 'exploratoryOtherMediumMeteredUsd': sum(e['priced']['usd'] for e in other_medium if e.get('priced'))-retry_usd, 'otherMediumRequests': len(other_medium), 'otherMediumMeteredUsd': sum(e['priced']['usd'] for e in other_medium if e.get('priced')), 'otherMediumUnresolvedReserveUsd': sum(e.get('reservedUsd', 0) for e in other_medium if not e.get('priced')), 'studyRequests': len(entries), 'studyMeteredUsd': sum(e['priced']['usd'] for e in entries if e.get('priced')), 'unresolvedStudyRequests': [e['id'] for e in entries if not e.get('priced')], 'cumulativeMeteredUsd': sum(e['priced']['usd'] for e in ledger if e.get('priced')), 'cumulativeReservedUsd': sum(e.get('reservedUsd', 0) for e in ledger if not e.get('priced')), 'budgetPaused': json.loads((root / 'budget-pause.json').read_text()) if (root / 'budget-pause.json').exists() else None}
report['unstartedPlanIds'] = sorted(plan_ids - {r['id'] for r in results})
report['costSpreadNote'] = 'All cost point spreads and deltas use known native-priced usage only; see intervals for unresolved reservations. Observed execution times are censored where reasons are listed.'
report['primaryCaseUsdInterval'] = [report['chargedPrimaryCaseMeteredUsd'], report['chargedPrimaryCaseMeteredUsd'] + sum(e.get('reservedUsd',0) for e in entries+retry_entries if not e.get('priced'))]
report['cumulativeExposureUsd'] = report['cumulativeMeteredUsd'] + report['cumulativeReservedUsd']
(root / 'summary.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
