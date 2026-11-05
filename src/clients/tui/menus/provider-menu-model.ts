import type {
  MenuOAuthAccount as OAuthAccountSummary,
  MenuProviderDraft as CustomProviderDraft,
  MenuProviderItem as ProviderSelectionItem,
  TuiProviderMenu,
} from '../integration.js';

/** Copied from src/model/providers/provider-service.ts. */
export type ProviderSelectionPhase =
  | 'list'
  | 'accounts'
  | 'presets'
  | 'edit_fields'
  | 'wizard_name'
  | 'wizard_type'
  | 'wizard_url'
  | 'wizard_key'
  | 'confirm_delete'
  | 'confirm_discard';

export type ProviderSelectionMenuItem =
  | {
      kind: 'preset';
      id: string;
      label: string;
      docsUrl: string;
    }
  | {
      kind: 'provider';
      id: string;
      label: string;
      isActive: boolean;
      isCustom: boolean;
      hasCredentials?: boolean;
      isDisabled?: boolean;
    }
  | {
      kind: 'add-provider';
      label: string;
    }
  | {
      kind: 'action';
      label: string;
      tone?: 'default' | 'destructive';
    }
  | {
      kind: 'field';
      label: string;
      detail?: string;
      fieldKey?: 'name' | 'type' | 'baseUrl' | 'apiKey';
    }
  | {
      kind: 'type';
      label: string;
    }
  | {
      kind: 'account';
      id: string;
      label: string;
      isSelected: boolean;
      isInUse: boolean;
    }
  | {
      kind: 'note';
      label: string;
    };

/** The /providers rows for one phase: a pure projection of the manager's state, with no navigation. */
export function buildProviderMenuItems(
  state: {
    phase: ProviderSelectionPhase;
    input: string;
    items: ProviderSelectionItem[];
    draft: CustomProviderDraft | null;
    editingOriginalName: string | null;
    accounts: OAuthAccountSummary[];
    accountProviderId: string | null;
  },
  api: TuiProviderMenu,
  sessionId: string,
): ProviderSelectionMenuItem[] {
  const { phase, input, items, draft, editingOriginalName, accounts, accountProviderId } = state;
  const PROVIDER_TYPES = api.types as CustomProviderDraft['type'][];
  const PROVIDER_PRESETS = api.presets();
  const getProvider = (_id: string) => true; // presets() already holds only registered built-ins
  const isProviderBuiltIn = api.isBuiltIn;
  const isProviderDisabled = (id: string) => api.isDisabled(sessionId, id);
  const oauthLoginCommand = api.loginCommand;

  switch (phase) {
    case 'list':
      return [
        ...items.map((i) => ({
          kind: 'provider' as const,
          id: i.id,
          label: i.label,
          isActive: i.isActive,
          isCustom: i.isCustom,
          hasCredentials: i.hasCredentials,
          isDisabled: i.isDisabled,
        })),
        { kind: 'add-provider' as const, label: 'Add Provider' },
      ];
    case 'presets':
      return [
        ...PROVIDER_PRESETS.filter((preset) => !preset.builtinProviderId || getProvider(preset.builtinProviderId))
          .filter((preset) =>
            `${preset.id} ${preset.name} ${preset.category}`.toLowerCase().includes(input.trim().toLowerCase()),
          )
          .map((preset) => ({ kind: 'preset' as const, id: preset.id, label: preset.name, docsUrl: preset.docsUrl })),
        { kind: 'action' as const, label: 'Custom endpoint' },
      ];
    case 'accounts': {
      if (accounts.length === 0) {
        return [
          {
            kind: 'note' as const,
            label: accountProviderId
              ? `No accounts stored. Run \`${oauthLoginCommand(accountProviderId)}\` to add one.`
              : 'No accounts stored.',
          },
        ];
      }
      return [
        ...accounts.map((account) => ({
          kind: 'account' as const,
          id: account.id,
          label: account.label,
          isSelected: account.isSelected,
          isInUse: account.isInUse,
        })),
        {
          kind: 'note' as const,
          label: accountProviderId
            ? `Add another with \`${oauthLoginCommand(accountProviderId)}\``
            : 'Add another by logging in again',
        },
      ];
    }
    case 'wizard_type':
      return PROVIDER_TYPES.map((type) => ({ kind: 'type' as const, label: type }));
    case 'edit_fields': {
      if (!draft) return [];
      const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
      const editingDisabled = editingOriginalName ? isProviderDisabled(editingOriginalName) : false;
      const toggleLabel = editingDisabled ? 'Enable Provider' : 'Disable Provider';
      if (isEditingBuiltIn) {
        return [
          { kind: 'field' as const, label: `Name: ${draft.name || '<empty>'} (Built-in)`, fieldKey: 'name' },
          { kind: 'field' as const, label: `Type: ${draft.type || '<empty>'} (Built-in)`, fieldKey: 'type' },
          {
            kind: 'field' as const,
            label: 'API Key',
            detail: draft.apiKey ? '********' : '<empty>',
            fieldKey: 'apiKey',
          },
          { kind: 'action' as const, label: toggleLabel },
          { kind: 'action' as const, label: 'Save Changes' },
          { kind: 'action' as const, label: 'Cancel' },
        ];
      }
      return [
        { kind: 'field' as const, label: `Name: ${draft.name || '<empty>'}`, fieldKey: 'name' },
        { kind: 'field' as const, label: `Type: ${draft.type || '<empty>'}`, fieldKey: 'type' },
        {
          kind: 'field' as const,
          label: 'Base URL',
          detail: draft.baseUrl || '<empty>',
          fieldKey: 'baseUrl',
        },
        {
          kind: 'field' as const,
          label: 'API Key',
          detail: draft.apiKey ? '********' : '<empty>',
          fieldKey: 'apiKey',
        },
        ...(editingOriginalName ? [{ kind: 'action' as const, label: toggleLabel }] : []),
        { kind: 'action' as const, label: 'Save Changes' },
        { kind: 'action' as const, label: 'Cancel' },
      ];
    }
    case 'confirm_discard':
      return [
        { kind: 'action' as const, label: 'Yes, discard changes', tone: 'destructive' as const },
        { kind: 'action' as const, label: 'No, keep editing' },
      ];
    case 'confirm_delete':
      return [
        { kind: 'action' as const, label: 'Yes, delete this provider', tone: 'destructive' as const },
        { kind: 'action' as const, label: 'No, keep it' },
      ];
    default:
      return [];
  }
}

/** The draft a registered provider's editor starts from: its stored settings, or a blank custom entry. */
export function storedProviderDraft(
  provider: { id: string; label: string; isCustom: boolean },
  api: TuiProviderMenu,
  sessionId: string,
): { draft: CustomProviderDraft; originalName: string | null } {
  const settingsReader = { getDynamic: (key: string) => api.getDynamic(sessionId, key) };
  if (provider.isCustom) {
    const list = (settingsReader.getDynamic('providers') as any[]) || [];
    const found = list.find((p: any) => api.resolveProviderId(p) === provider.id);
    const storedKey = found?.apiKey || '';
    if (!found) {
      return { draft: { name: provider.id, type: 'openai-compatible', baseUrl: '', apiKey: '' }, originalName: null };
    }
    const id = api.resolveProviderId(found) ?? provider.id;
    return {
      draft: {
        name: api.resolveProviderName(found, id),
        type: found.type || 'openai-compatible',
        baseUrl: found.baseUrl || '',
        apiKey: storedKey,
      },
      originalName: id,
    };
  }
  // Built-in providers edit only their API key.
  const credentialSettingKey = api.credentialSettingKey(provider.id);
  const storedKey = credentialSettingKey ? (settingsReader.getDynamic(credentialSettingKey) as string) || '' : '';
  return { draft: { name: provider.label, type: provider.id, apiKey: storedKey }, originalName: provider.id };
}
