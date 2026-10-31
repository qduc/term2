/**
 * Real providers behind `ModelRegistry`, without the adopted adapter. The only
 * place that sees provider shapes: `Item` converts here and nowhere else.
 *
 * `resolve` is synchronous and source `createStreamedModel` is not, so the
 * returned `Model` creates the provider model on first `stream`.
 */

import type {
  ILoggingService,
  ISessionContextService,
  ISettingsService,
} from '../../../source/services/service-interfaces.js';
import type { ModelRegistry } from './index.js';

export type ProviderRegistryDeps = {
  readonly settings: ISettingsService;
  readonly logger: ILoggingService;
  readonly sessionContext: ISessionContextService;
};

export function createProviderRegistry(_deps: ProviderRegistryDeps): ModelRegistry {
  throw new Error('createProviderRegistry is not implemented yet (M1 task 1)');
}
