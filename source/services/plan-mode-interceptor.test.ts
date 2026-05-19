import test from 'ava';
import { installPlanModeInterceptor } from './plan-mode-interceptor.js';

test('installPlanModeInterceptor rejects mutating tools when planMode is true', async (t) => {
  let capturedInterceptor: any;
  let planMode = true;

  const mockSettingsService = {
    get: (key: string) => {
      if (key === 'app.planMode') return planMode;
      return false;
    },
  } as any;

  installPlanModeInterceptor(
    {
      addToolInterceptor(interceptor) {
        capturedInterceptor = interceptor;
        return () => {};
      },
    },
    { settingsService: mockSettingsService },
  );

  t.truthy(capturedInterceptor);

  // When planMode is true, mutating tools should be blocked
  const rejectCreate = await capturedInterceptor('create_file', {});
  t.truthy(rejectCreate);
  t.true(rejectCreate.includes('disabled'));

  const rejectSearchReplace = await capturedInterceptor('search_replace', {});
  t.truthy(rejectSearchReplace);
  t.true(rejectSearchReplace.includes('disabled'));

  const rejectApplyPatch = await capturedInterceptor('apply_patch', {});
  t.truthy(rejectApplyPatch);
  t.true(rejectApplyPatch.includes('disabled'));

  // Write-capable worker subagent is blocked
  const rejectWorker = await capturedInterceptor('run_subagent', { role: 'worker' });
  t.truthy(rejectWorker);
  t.true(rejectWorker.includes('disabled'));

  // Unknown / missing role is blocked (could be a write-capable custom role)
  t.truthy(await capturedInterceptor('run_subagent', {}));
  t.truthy(await capturedInterceptor('run_subagent', { role: 'mystery' }));

  // Read-only subagent roles are allowed in plan mode
  t.is(await capturedInterceptor('run_subagent', { role: 'explorer' }), null);
  t.is(await capturedInterceptor('run_subagent', { role: 'researcher' }), null);
  t.is(await capturedInterceptor('run_subagent', { role: 'mentor' }), null);
  // Role passed as a JSON string (provider may stringify args)
  t.is(await capturedInterceptor('run_subagent', JSON.stringify({ role: 'explorer' })), null);

  // Non-mutating tools should pass through
  t.is(await capturedInterceptor('read_file', {}), null);
  t.is(await capturedInterceptor('grep', {}), null);
  t.is(await capturedInterceptor('shell', {}), null);

  // When planMode is false, all tools should pass through
  planMode = false;
  t.is(await capturedInterceptor('create_file', {}), null);
  t.is(await capturedInterceptor('search_replace', {}), null);
  t.is(await capturedInterceptor('apply_patch', {}), null);
  t.is(await capturedInterceptor('run_subagent', {}), null);
  t.is(await capturedInterceptor('read_file', {}), null);
});
