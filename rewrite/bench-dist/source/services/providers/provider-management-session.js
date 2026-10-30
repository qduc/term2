import { deleteCustomProvider, loadProviderItems, saveProvider, } from '../../providers/provider-service.js';
/** Public policy seam for provider management; Ink owns selection and display state. */
export class ProviderManagementSession {
    #settings;
    constructor(settings) {
        this.#settings = settings;
    }
    list() {
        return loadProviderItems(this.#settings);
    }
    save(draft, editingOriginalName) {
        return saveProvider(this.#settings, draft, editingOriginalName);
    }
    delete(providerId) {
        deleteCustomProvider(this.#settings, providerId);
    }
}
//# sourceMappingURL=provider-management-session.js.map