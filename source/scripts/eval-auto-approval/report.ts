import { Metrics, ResultRecord } from './metrics.js';

export function generateReport(results: ResultRecord[], metrics: Metrics): string {
  const sections: string[] = [];

  sections.push('# Shell Auto-Approval Evaluation Report');
  sections.push(`Date: ${new Date().toLocaleString()}`);
  sections.push(`Total Cases: ${metrics.total}`);

  sections.push('## Overall Performance');
  sections.push('| Metric | Value |');
  sections.push('| --- | --- |');
  sections.push(`| Accuracy | ${(metrics.accuracy * 100).toFixed(1)}% |`);
  sections.push(`| Precision (Reject) | ${(metrics.precision * 100).toFixed(1)}% |`);
  sections.push(`| Recall (Reject) | ${(metrics.recall * 100).toFixed(1)}% |`);
  sections.push(`| F1 Score | ${metrics.f1.toFixed(3)} |`);
  sections.push(`| False Approve Rate | ${(metrics.falseApproveRate * 100).toFixed(1)}% |`);
  sections.push(`| False Reject Rate | ${(metrics.falseRejectRate * 100).toFixed(1)}% |`);
  sections.push(`| Critical Failures | ${metrics.criticalFailures} |`);
  sections.push(`| Latency P50 | ${Math.round(metrics.latencyP50)}ms |`);
  sections.push(`| Latency P95 | ${Math.round(metrics.latencyP95)}ms |`);
  sections.push(`| Parse Error Rate | ${(metrics.parseErrorRate * 100).toFixed(1)}% |`);

  sections.push('## Performance by Category');
  sections.push('| Category | Total | Correct | Accuracy |');
  sections.push('| --- | --- | --- | --- |');
  for (const [cat, m] of Object.entries(metrics.byCategory)) {
    sections.push(`| ${cat} | ${m.total} | ${m.correct} | ${(m.accuracy * 100).toFixed(1)}% |`);
  }

  const failures = results.filter((r) => r.predicted !== r.expected || r.error);
  if (failures.length > 0) {
    sections.push('## Failures');
    sections.push('| Case ID | Expected | Predicted | Severity | Category | Reasoning |');
    sections.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of failures) {
      const reasoning = (f.reasoning || f.error || '').replace(/\n/g, ' ').slice(0, 100);
      sections.push(
        `| ${f.caseId} | ${f.expected} | ${f.predicted || 'ERROR'} | ${f.severity} | ${f.category} | ${reasoning}... |`,
      );
    }
  }

  const criticalFailures = results.filter(
    (r) => r.expected === 'reject' && r.predicted === 'approve' && r.severity === 'critical',
  );
  if (criticalFailures.length > 0) {
    sections.push('## Critical Failures (FALSE APPROVE on CRITICAL)');
    for (const f of criticalFailures) {
      sections.push(`### Case: ${f.caseId}`);
      sections.push(`- **Command**: 
${f.command}
`);
      sections.push(`- **Reasoning**: ${f.reasoning}`);
    }
  }

  return sections.join('\n\n');
}
