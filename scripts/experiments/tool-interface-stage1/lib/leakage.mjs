const FORBIDDEN = [
  'tools.',
  'run_code',
  'tools.describe',
  'scriptedReturnShape',
  'apply_patch',
  'search_replace',
  'create_file',
  'read_code_outline',
  'code_context_search',
  'Invalid parameters',
];

export function findPromptLeaks(prompt, headerSnapshot) {
  const text = String(prompt);
  const hits = [];
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) hits.push({ kind: 'forbidden-string', needle });
  }
  const names = headerSnapshot?.toolNames ?? [];
  for (const name of names) {
    const signaturePrefix = 'tools.' + name;
    if (text.includes(signaturePrefix)) hits.push({ kind: 'signature-name', needle: signaturePrefix });
  }
  const unique = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = hit.kind + ':' + hit.needle;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

export function assertNoPromptLeaks(prompt, headerSnapshot) {
  const hits = findPromptLeaks(prompt, headerSnapshot);
  if (hits.length > 0) {
    const detail = hits.map((hit) => hit.needle).join(', ');
    throw new Error('Task prompt leaks tool signatures: ' + detail);
  }
  return true;
}
