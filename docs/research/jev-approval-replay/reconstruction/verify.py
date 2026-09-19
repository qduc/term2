#!/usr/bin/env python3
"""Offline validation for the reconstruct-184 artifact set."""
from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(message: str) -> None:
    raise SystemExit(f'FAIL: {message}')


def main() -> None:
    required = ['dataset.jsonl', 'join-report.json', 'README.md', 'receipt.json']
    for name in required:
        if not (ROOT / name).is_file():
            fail(f'missing {name}')
    rows = []
    for number, line in enumerate((ROOT / 'dataset.jsonl').read_text().splitlines(), 1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            fail(f'dataset.jsonl line {number}: {error}')
        required_fields = {'case_id', 'source_references', 'ordered_batch_position', 'command_request', 'reviewer', 'jev', 'compact_task_context', 'fuller_conversation_context_ending_at_command_request', 'latest_user_request', 'prior_human_decision_evidence', 'join_confidence', 'join_reasons'}
        missing = required_fields - row.keys()
        if missing:
            fail(f'{row.get("case_id", number)} missing {sorted(missing)}')
        for actor in ('reviewer', 'jev'):
            if not {'risk_level', 'authorization', 'confidence', 'decision'} <= row[actor].keys():
                fail(f'{row["case_id"]} incomplete {actor} labels')
        if row['join_confidence'] not in {'exact', 'high', 'ambiguous', 'unmatched'}:
            fail(f'{row["case_id"]} invalid join confidence')
        for reference in row['source_references'].values():
            if not Path(reference['path']).exists():
                fail(f'{row["case_id"]} missing source path {reference["path"]}')
        rows.append(row)
    if len(rows) != 184 or len({row['case_id'] for row in rows}) != len(rows):
        fail('dataset must contain 184 unique stable case IDs')
    report = json.loads((ROOT / 'join-report.json').read_text())
    counts = report['counts']
    expected = report['expected_aggregate']
    computed = {
        'risk_label_matches': sum(r['reviewer']['risk_level'] == r['jev']['risk_level'] for r in rows),
        'authorization_label_matches': sum(r['reviewer']['authorization'] == r['jev']['authorization'] for r in rows),
        'classification_agreements': sum(r['reviewer']['risk_level'] == r['jev']['risk_level'] and r['reviewer']['authorization'] == r['jev']['authorization'] for r in rows),
        'eligibility_agreements': sum(r['reviewer']['decision'] == r['jev']['decision'] for r in rows),
        'reviewer_approvals': sum(r['reviewer']['decision'] == 'approve' for r in rows),
        'jev_weak_or_unknown': sum(r['jev']['authorization'] in {'weak', 'unknown'} for r in rows),
    }
    if any(computed[key] != counts[key] or computed[key] != expected[key] for key in computed):
        fail('aggregate cross-tabs do not match dataset and expected frozen cohort')
    if report['dataset_sha256'] != digest(ROOT / 'dataset.jsonl'):
        fail('dataset digest mismatch')
    for source in report['source_inputs']['traffic_files']:
        if not Path(source['path']).exists() or digest(Path(source['path'])) != source['sha256']:
            fail(f'traffic source changed or missing: {source["path"]}')
    receipt = json.loads((ROOT / 'receipt.json').read_text())
    if receipt.get('declared_children') != []:
        fail('declared_children must be []')
    expected_argv = ['python3', '/home/qduc/term2/docs/research/jev-approval-replay/reconstruction/verify.py']
    if receipt.get('verification_argv') != expected_argv:
        fail('verification argv differs from coordinator-supplied argv')
    for artifact in receipt.get('artifacts', []):
        path = Path(artifact['path'])
        if not path.is_file() or digest(path) != artifact['sha256']:
            fail(f'artifact digest mismatch: {path}')
    print(f'PASS: 184 rows; {dict(Counter(r["join_confidence"] for r in rows))}; frozen aggregate verified')


if __name__ == '__main__':
    main()
