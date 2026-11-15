import type { ISettingsService } from '../../shared/service-interfaces.js';

/**
 * Log validation errors for debugging
 */
export function logValidationError(settingsService: ISettingsService, message: string): void {
  if (!settingsService.get('debug.debugBashTool')) {
    return;
  }
  if (settingsService.get('logging.suppressConsoleOutput')) {
    return;
  }

  console.error(`[BASH_TOOL_ERROR] ${message}`);
}
