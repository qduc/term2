import { it, expect } from 'vitest';
import { installPlanModeInterceptor } from './plan-mode-interceptor.js';

it('installPlanModeInterceptor rejects mutating tools when planMode is true', async () => {
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

  expect(capturedInterceptor).toBeTruthy();

  // When planMode is true, mutating tools should be blocked
  const rejectCreate = await capturedInterceptor('create_file', {});
  expect(rejectCreate).toBeTruthy();
  expect(rejectCreate.includes('disabled')).toBe(true);

  const rejectSearchReplace = await capturedInterceptor('search_replace', {});
  expect(rejectSearchReplace).toBeTruthy();
  expect(rejectSearchReplace.includes('disabled')).toBe(true);

  const rejectApplyPatch = await capturedInterceptor('apply_patch', {});
  expect(rejectApplyPatch).toBeTruthy();
  expect(rejectApplyPatch.includes('disabled')).toBe(true);

  // Write-capable worker subagent is blocked
  const rejectWorker = await capturedInterceptor('run_subagent', { role: 'worker' });
  expect(rejectWorker).toBeTruthy();
  expect(rejectWorker.includes('disabled')).toBe(true);

  // Unknown / missing role is blocked (could be a write-capable custom role)
  expect(await capturedInterceptor('run_subagent', {})).toBeTruthy();
  expect(await capturedInterceptor('run_subagent', { role: 'mystery' })).toBeTruthy();

  // Read-only subagent roles are allowed in plan mode
  expect(await capturedInterceptor('run_subagent', { role: 'explorer' })).toBe(null);
  expect(await capturedInterceptor('run_subagent', { role: 'researcher' })).toBe(null);
  expect(await capturedInterceptor('run_subagent', { role: 'mentor' })).toBe(null);
  // Role passed as a JSON string (provider may stringify args)
  expect(await capturedInterceptor('run_subagent', JSON.stringify({ role: 'explorer' }))).toBe(null);

  // Non-mutating tools should pass through
  expect(await capturedInterceptor('read_file', {})).toBe(null);
  expect(await capturedInterceptor('grep', {})).toBe(null);
  expect(await capturedInterceptor('shell', {})).toBe(null);

  // When planMode is false, all tools should pass through
  planMode = false;
  expect(await capturedInterceptor('create_file', {})).toBe(null);
  expect(await capturedInterceptor('search_replace', {})).toBe(null);
  expect(await capturedInterceptor('apply_patch', {})).toBe(null);
  expect(await capturedInterceptor('run_subagent', {})).toBe(null);
  expect(await capturedInterceptor('read_file', {})).toBe(null);
});
