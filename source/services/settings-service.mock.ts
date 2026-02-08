import { SettingsService } from './settings-service.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';

/**
 * Helper to unflatten dot-notation keys into nested objects.
 * e.g. {'agent.model': 'gpt-4'} -> {agent: {model: 'gpt-4'}}
 */
function unflatten(data: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const parts = key.split('.');
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        current[part] = current[part] || {};
        current = current[part];
      }
      current[parts[parts.length - 1]] = data[key];
    }
  }
  return result;
}

/**
 * Creates a mock SettingsService instance for testing.
 * This prevents tests from modifying the user's actual settings file
 * and ensures test isolation by using unique temporary directories.
 *
 * @param overrides - Optional settings to override defaults (supports dot-notation keys)
 * @returns A mock SettingsService instance
 */
export function createMockSettingsService(
  overrides: Partial<{
    [key: string]: any;
  }> = {},
): SettingsService {
  // Create a unique temporary directory for each mock instance
  // This ensures tests running in parallel don't interfere with each other
  const tempDir = mkdtempSync(join(tmpdir(), 'term2-test-'));

  // Unflatten overrides so they match the nested structure expected by SettingsService
  // This allows passing {'agent.model': 'val'} convenience keys
  const nestedOverrides = unflatten(overrides);

  // Create a mock settings service with isolated storage
  return new SettingsService({
    settingsDir: tempDir,
    disableLogging: true, // Disable logging for tests
    disableFilePersistence: true, // Never write settings.json during tests
    cli: nestedOverrides, // Apply any overrides
  });
}

/**
 * Mock settings service instance for testing.
 * This is a pre-configured mock that can be used in tests.
 * Note: If you modify settings on this instance, other tests using it will verify those changes.
 * For true isolation, prefer calling createMockSettingsService() in your test setup.
 */
export const mockSettingsService = createMockSettingsService();
