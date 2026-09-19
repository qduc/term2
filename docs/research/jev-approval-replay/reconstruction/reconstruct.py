#!/usr/bin/env python3
"""Build the frozen 184-case approval-shadow replay dataset from local evidence.

This is deliberately local-only: it reads persisted records and never makes a
provider request.  The output records preserve user-provided content, so the
small redactor is applied before any content is written.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path

OUT = Path(__file__).resolve().parent
LOG = Path('/home/qduc/.local/state/term2-nodejs/logs/term2-2026-09-19.log')
TRAFFIC = Path('/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-19')
CONVERSATIONS = Path('/home/qduc/.local/share/term2-nodejs/conversations')
CUTOFF_ID = 'msg-1789801585760-jfs4b6'
CUTOFF_TIMESTAMP = '2026-09-19 14:06:25'
# The next evaluator traffic session begins the reconstruction work itself. The
# frozen production capture ends at this received event; do not mix live work
# into the cohort merely because it writes to the same date directory.
TRAFFIC_CUTOFF = '2026-09-19T07:06:24.211Z'
EXPECTED = {
    'risk_label_matches': 140,
    'authorization_label_matches': 31,
    'classification_agreements': 25,
    'eligibility_agreements': 93,
    'reviewer_approvals': 180,
    'jev_weak_or_unknown': 95,
}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def redact(value: str) -> str:
    """Remove common secret forms while preserving contextual structure."""
    value = re.sub(r'(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"}]+', r'\1[REDACTED]', value)
    value = re.sub(r'(?i)\b(sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;"}]+',
                   lambda m: '[REDACTED]' if m.group(0).lower().startswith('sk-') else m.group(0).split(m.group(0)[len(m.group(1)):])[0] + '[REDACTED]', value)
    value = re.sub(r'(?i)\b(?:OPENAI|OPENROUTER|ANTHROPIC)_[A-Z0-9_]*KEY\s*=\s*[^\s]+',
                   lambda m: m.group(0).split('=')[0] + '=[REDACTED]', value)
    return value


def text_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(str(part.get('text', '')) for part in content if isinstance(part, dict))
    return ''


def between(text: str, tag: str) -> str | None:
    match = re.search(rf'<{tag}>\n?(.*?)\n?</{tag}>', text, flags=re.S)
    return redact(match.group(1).strip()) if match else None


def parse_requests(prompt: str) -> list[dict[str, object]]:
    body = between(prompt, 'approval_requests') or ''
    parts = re.split(r'(?=\[(?:Command|Request) \d+(?:: [^\]]+)?\]\n)', body)
    requests: list[dict[str, object]] = []
    for part in parts:
        match = re.match(r'\[(Command|Request) (\d+)(?:: ([^\]]+))?\]\n(.*)', part, flags=re.S)
        if not match:
            continue
        kind, position, tool, detail = match.groups()
        request: dict[str, object] = {
            'ordered_batch_position': int(position),
            'tool_name': tool or 'shell',
            'request_kind': kind.lower(),
            'request_text': redact(detail.strip()),
        }
        if kind == 'Command':
            request['command'] = redact(detail.split('\n[Execution context:', 1)[0].strip())
            request['unsandboxed'] = '[Execution context: runs OUTSIDE the sandbox with host access.]' in detail
        else:
            target = re.search(r'^Target: ?(.*)$', detail, flags=re.M)
            if target:
                request['target'] = redact(target.group(1))
        requests.append(request)
    return requests


def parse_response(record: dict[str, object]) -> list[dict[str, object]] | None:
    try:
        choices = record['received']['summary']['payload']['choices']  # type: ignore[index]
        raw = ''.join(str(choice.get('delta', {}).get('content') or '') for choice in choices)
        start, end = raw.find('{'), raw.rfind('}')
        if start < 0 or end < start:
            return None
        parsed = json.loads(raw[start:end + 1])
        results = parsed.get('results')
        if not isinstance(results, list):
            return None
        valid = {'low', 'medium', 'high'}
        auth = {'explicit', 'implied', 'weak', 'unknown'}
        if any(not isinstance(item, dict) or item.get('riskLevel') not in valid or item.get('authorization') not in auth for item in results):
            return None
        return results
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def traffic_batches() -> list[dict[str, object]]:
    batches = []
    for path in sorted(TRAFFIC.rglob('evaluator_*.json')):
        try:
            record = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        result = parse_response(record)
        if not result:
            continue
        messages = record.get('sent', {}).get('body', {}).get('messages', [])
        prompt = next((text_content(message.get('content')) for message in messages
                       if isinstance(message, dict) and '<approval_requests>' in text_content(message.get('content'))), '')
        requests = parse_requests(prompt)
        if len(requests) != len(result):
            continue
        sent = record['sent']
        if str(sent.get('timestamp', '')) > TRAFFIC_CUTOFF:
            continue
        batches.append({
            'path': str(path),
            'path_sha256': sha256_file(path),
            'sent_timestamp': sent.get('timestamp'),
            'received_timestamp': record.get('received', {}).get('timestamp'),
            'session_id': sent.get('sessionId'),
            'request_id': sent.get('requestId'),
            'reviewer_results': result,
            'compact_task_context': between(prompt, 'task_context') or '(unavailable)',
            'prior_human_decisions': between(prompt, 'prior_human_decisions') or '(unavailable)',
            'requests': requests,
        })
    return sorted(batches, key=lambda batch: str(batch['sent_timestamp']))


def log_groups() -> list[dict[str, object]]:
    comparisons = []
    with LOG.open() as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get('eventType') == 'approval.decision_shadow.compared':
                comparisons.append(record)
                if record.get('messageId') == CUTOFF_ID:
                    break
    if len(comparisons) != 184 or comparisons[-1].get('messageId') != CUTOFF_ID:
        raise RuntimeError(f'frozen cohort was not exactly 184 records ending at {CUTOFF_ID}')
    groups: list[dict[str, object]] = []
    current: list[dict[str, object]] = []
    for record in comparisons:
        if record['requestIndex'] == 0 and current:
            groups.append({'records': current})
            current = []
        current.append(record)
    if current:
        groups.append({'records': current})
    if any([record['requestIndex'] for record in group['records']] != list(range(len(group['records']))) for group in groups):
        raise RuntimeError('app-log batch requestIndex values were not contiguous from zero')
    return groups


def signature(items: list[dict[str, object]], source: str) -> tuple[tuple[object, object, object], ...]:
    if source == 'log':
        return tuple((item.get('reviewerRiskLevel'), item.get('reviewerAuthorization'), item.get('reviewerConfidence')) for item in items)
    return tuple((item.get('riskLevel'), item.get('authorization'), item.get('confidence')) for item in items)


def app_batch_utc(group: dict[str, object]) -> datetime:
    """The message ID retains UTC milliseconds while the rendered log timestamp is UTC+07:00."""
    message_id = str(group['records'][0]['messageId'])
    match = re.match(r'msg-(\d+)-', message_id)
    if not match:
        raise RuntimeError(f'cannot extract milliseconds from {message_id}')
    return datetime.fromtimestamp(int(match.group(1)) / 1000, tz=timezone.utc)


def conversation_context(session_id: object, before: object) -> tuple[str | None, str | None]:
    if not isinstance(session_id, str) or not isinstance(before, str):
        return None, None
    path = CONVERSATIONS / f'{session_id}.jsonl'
    if not path.exists():
        return None, None
    entries: list[str] = []
    latest_user = None
    try:
        for line in path.open():
            envelope = json.loads(line)
            if str(envelope.get('ts', '')) > before:
                break
            event = envelope.get('event', {})
            if not isinstance(event, dict):
                continue
            typ = event.get('type')
            message = event.get('message')
            if typ == 'assistant_journal_item' and isinstance(event.get('item'), dict) and event['item'].get('type') == 'assistant_text':
                text = event['item'].get('text')
                if isinstance(text, str) and text.strip():
                    entries.append(f'[assistant] {redact(text.strip())}')
            elif typ in {'user_message', 'assistant_message'} and isinstance(message, dict):
                text = message.get('text')
                if isinstance(text, str) and text.strip():
                    rendered = f'[{"user" if typ == "user_message" else "assistant"}] {redact(text.strip())}'
                    entries.append(rendered)
                    if typ == 'user_message':
                        latest_user = redact(text.strip())
            elif typ == 'tool_started' and isinstance(event.get('arguments'), dict):
                args = redact(json.dumps(event['arguments'], ensure_ascii=False, sort_keys=True))
                entries.append(f'[tool request] {event.get("toolName", "unknown")} {args}')
    except (OSError, json.JSONDecodeError):
        return None, None
    return ('\n'.join(entries) if entries else None), latest_user


def main() -> None:
    groups = log_groups()
    batches = traffic_batches()
    assigned_batches: dict[int, dict[str, object]] = {}
    used_traffic_indexes: set[int] = set()
    timing_diagnostics = []
    for group_index, group in enumerate(groups):
        target = app_batch_utc(group)
        expected_signature = signature(group['records'], 'log')
        candidates = [
            (index, batch) for index, batch in enumerate(batches)
            if index not in used_traffic_indexes
            and signature(batch['reviewer_results'], 'traffic') == expected_signature
            and datetime.fromisoformat(str(batch['received_timestamp']).replace('Z', '+00:00')) <= target
        ]
        if not candidates:
            all_signature_indexes = [index + 1 for index, batch in enumerate(batches) if signature(batch['reviewer_results'], 'traffic') == expected_signature]
            raise RuntimeError(
                f'no unused preceding evaluator batch matches app batch {group_index + 1}; '
                f'target={target.isoformat()} used_traffic_indexes={sorted(index + 1 for index in used_traffic_indexes)} '
                f'all_signature_indexes={all_signature_indexes}'
            )
        traffic_index, batch = max(candidates, key=lambda candidate: str(candidate[1]['received_timestamp']))
        assigned_batches[group_index] = batch
        used_traffic_indexes.add(traffic_index)
        timing_diagnostics.append({
            'app_batch_index': group_index + 1,
            'app_batch_utc': target.isoformat().replace('+00:00', 'Z'),
            'traffic_batch_index': traffic_index + 1,
            'traffic_sent_timestamp': batch['sent_timestamp'],
            'traffic_received_timestamp': batch['received_timestamp'],
            'candidate_count_before_nearest': len(candidates),
            'file_order_reordered_from_previous_app_batch': group_index > 0 and traffic_index < timing_diagnostics[-1]['traffic_batch_index'] - 1,
        })
    used_paths = {batch['path'] for batch in assigned_batches.values()}
    extraneous = [batch for batch in batches if batch['path'] not in used_paths]
    comparisons = [record for group in groups for record in group['records']]

    rows = []
    context_cache: dict[tuple[object, object], tuple[str | None, str | None]] = {}
    for group_index, group in enumerate(groups):
        batch = assigned_batches[group_index]
        for request_index, comparison in enumerate(group['records']):
            request = batch['requests'][request_index]
            cache_key = (batch['session_id'], batch['sent_timestamp'])
            if cache_key not in context_cache:
                context_cache[cache_key] = conversation_context(*cache_key)
            full_context, latest_user = context_cache[cache_key]
            confidence = 'high'
            reasons = ['one-to-one batch join: identical ordered reviewer risk/authorization/confidence vector and batch size; selected as the nearest unused evaluator batch whose received time precedes the UTC message-ID time (the rendered app-log timestamp is UTC+07:00). File order is not imposed because concurrent evaluator calls can be written in completion/app order opposite sent-file order.']
            source_refs = {
                'app_log': {'path': str(LOG), 'message_id': comparison['messageId']},
                'traffic': {'path': batch['path'], 'request_id': batch['request_id'], 'session_id': batch['session_id']},
            }
            compact_context = batch['compact_task_context']
            prior_decisions = batch['prior_human_decisions']
            batch_position = request['ordered_batch_position']
            row = {
                'case_id': f'reconstruct-184-{len(rows) + 1:03d}',
                'source_references': source_refs,
                'timestamp': comparison['timestamp'],
                'correlation_id': comparison.get('correlationId'),
                'ordered_batch_position': batch_position,
                'command_request': request,
                'reviewer': {
                    'risk_level': comparison['reviewerRiskLevel'],
                    'authorization': comparison['reviewerAuthorization'],
                    'confidence': comparison['reviewerConfidence'],
                    'decision': 'approve' if comparison['reviewerRiskAuthorizationEligible'] else 'deny',
                },
                'jev': {
                    'risk_level': comparison['shadowRiskLevel'],
                    'authorization': comparison['shadowAuthorization'],
                    'confidence': comparison['shadowConfidence'],
                    'decision': 'approve' if comparison['shadowRiskAuthorizationEligible'] else 'deny',
                },
                'compact_task_context': compact_context,
                'fuller_conversation_context_ending_at_command_request': full_context or '(unrecoverable from persisted conversation evidence)',
                'latest_user_request': latest_user or '(unrecoverable)',
                'prior_human_decision_evidence': prior_decisions,
                'join_confidence': confidence,
                'join_reasons': reasons,
            }
            rows.append(row)

    dataset = OUT / 'dataset.jsonl'
    dataset.write_text(''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in rows))
    counts = {
        'total_cases': len(rows),
        'risk_label_matches': sum(row['reviewer']['risk_level'] == row['jev']['risk_level'] for row in rows),
        'authorization_label_matches': sum(row['reviewer']['authorization'] == row['jev']['authorization'] for row in rows),
        'classification_agreements': sum(
            row['reviewer']['risk_level'] == row['jev']['risk_level'] and row['reviewer']['authorization'] == row['jev']['authorization'] for row in rows),
        'eligibility_agreements': sum(row['reviewer']['decision'] == row['jev']['decision'] for row in rows),
        'reviewer_approvals': sum(row['reviewer']['decision'] == 'approve' for row in rows),
        'jev_weak_or_unknown': sum(row['jev']['authorization'] in {'weak', 'unknown'} for row in rows),
        'replayable_false_denials': sum(row['reviewer']['decision'] == 'approve' and row['jev']['decision'] == 'deny' and row['join_confidence'] in {'exact', 'high'} for row in rows),
    }
    report = {
        'run_id': 'jev-auth-replay-20260919',
        'task_id': 'reconstruct-184',
        'cohort_freeze': {
            'count': 184,
            'cutoff_timestamp': CUTOFF_TIMESTAMP,
            'cutoff_message_id': CUTOFF_ID,
            'later_comparison_events_excluded': {
                'count_at_initial_inspection': 8,
                'selection_rule': 'all comparison events after the cutoff are excluded; the live app log may append further events after this reconstruction begins',
            },
        },
        'counts': counts,
        'expected_aggregate': EXPECTED,
        'aggregate_verified': all(counts[key] == value for key, value in EXPECTED.items()),
        'cross_tabs': {
            'risk': dict(sorted(Counter(f"{row['reviewer']['risk_level']}->{row['jev']['risk_level']}" for row in rows).items())),
            'authorization': dict(sorted(Counter(f"{row['reviewer']['authorization']}->{row['jev']['authorization']}" for row in rows).items())),
            'decision': dict(sorted(Counter(f"{row['reviewer']['decision']}->{row['jev']['decision']}" for row in rows).items())),
        },
        'uniqueness_diagnostics': {
            'app_batches_by_request_index_reset': len(groups),
            'evaluator_batches_parseable': len(batches),
            'assigned_evaluator_batches': len(assigned_batches),
            'extraneous_evaluator_batches': [
                {'path': batch['path'], 'sent_timestamp': batch['sent_timestamp'], 'reason': 'not selected by the one-to-one monotonic time/signature join'}
                for batch in extraneous
            ],
            'concurrent_completion_reorders': [
                item for item in timing_diagnostics if item['file_order_reordered_from_previous_app_batch']
            ],
            'batch_timing': timing_diagnostics,
            'by_confidence': dict(Counter(row['join_confidence'] for row in rows)),
        },
        'excluded_or_ambiguous_rows': [row['case_id'] for row in rows if row['join_confidence'] not in {'exact', 'high'}],
        'source_inputs': {
            'app_log': {'path': str(LOG), 'frozen_event_sha256': sha256_bytes(''.join(json.dumps(record, sort_keys=True, separators=(',', ':')) for group in groups for record in group['records']).encode())},
            'traffic_files': [{'path': batch['path'], 'sha256': batch['path_sha256']} for batch in batches],
            'traffic_freeze': {'last_received_timestamp': TRAFFIC_CUTOFF},
            'conversation_root': {'path': str(CONVERSATIONS)},
        },
        'dataset_sha256': sha256_file(dataset),
        'agreement_interpretation': 'classification_agreements requires both risk and authorization labels; eligibility_agreements compares only the derived approve/deny decision. The reported 93/184 is eligibility agreement, not label agreement.',
    }
    (OUT / 'join-report.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
