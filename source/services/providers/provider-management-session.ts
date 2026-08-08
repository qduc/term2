import type { ISettingsService } from '../service-interfaces.js';
import {
  deleteCustomProvider,
  loadProviderItems,
  saveProvider,
  type CustomProviderDraft,
  type ProviderSelectionItem,
  type SaveProviderResult,
} from '../../providers/provider-service.js';

/** Public policy seam for provider management; Ink owns selection and display state. */
export class ProviderManagementSession {
  readonly #settings: ISettingsService;

  constructor(settings: ISettingsService) {
    this.#settings = settings;
  }

  list(): ProviderSelectionItem[] {
    return loadProviderItems(this.#settings);
  }

  save(draft: CustomProviderDraft, editingOriginalName: string | null): SaveProviderResult {
    return saveProvider(this.#settings, draft, editingOriginalName);
  }

  delete(providerId: string): void {
    deleteCustomProvider(this.#settings, providerId);
  }

  saveOrder(providerIds: readonly string[]): void {
    this.#settings.setPersistent('providerOrder', [...providerIds]);
  }
}
