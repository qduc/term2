import test from 'ava';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { getSubagentsRolesSection } from '../tools/run-subagent.js';

test('getSubagentDelegationAddendum returns delegation prompt structure', (t) => {
  const result = getSubagentDelegationAddendum();

  t.is(typeof result, 'string');
  t.true(result.length > 500);

  // Verify it contains structural Markdown headers
  t.true(result.includes('### Delegating to subagents'));
  t.true(result.includes('## Roles'));
});

test('getSubagentDelegationAddendum embeds the generated roles section', (t) => {
  const result = getSubagentDelegationAddendum();
  const rolesSection = getSubagentsRolesSection();

  t.true(result.includes(rolesSection), 'Should dynamically embed the roles section');
});
