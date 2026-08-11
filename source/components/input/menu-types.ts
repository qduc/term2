import type { RewindItem } from '../../utils/conversation/rewind-items.js';
import type { RewindDisposition } from '../../commands/rewind-command.js';
import type { CustomProviderDraft, ProviderSelectionItem } from '../../hooks/use-provider-selection.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { CopySelection } from '../../utils/copy-selections.js';
import type { TriggerRuleRegistry } from './menu-controller.js';

export type ProviderField = 'name' | 'type' | 'baseUrl' | 'apiKey';

export type EditorSnapshot = Readonly<{
  text: string;
  cursor: number;
  revision: number;
}>;

export type TextRange = Readonly<{
  start: number;
  end: number;
}>;

export type ReplacementEnd = 'cursor' | 'buffer-end' | number;

export type TextBinding = Readonly<{
  trigger: {
    range: TextRange;
    text: string;
  };
  queryStart: number;
  queryEnd: 'cursor';
  query: string;
  replacement: {
    start: number;
    end: ReplacementEnd;
  };
  activationId: string;
  revision: number;
}>;

export type FrameId = string;

export type ReturnPoint = Readonly<{
  editor: EditorSnapshot;
}>;

export type BackPolicy =
  | { type: 'restore'; point: ReturnPoint }
  | { type: 'close-preserve-input' }
  | { type: 'close-clear-input' };

export type SettingsOrigin =
  | { type: 'settings-list'; operation: 'set'; back: BackPolicy }
  | { type: 'direct-trigger'; triggerId: string; back: BackPolicy };

// Mirrors the fields of utils/ai/model-settings.ts's ModelSettingConfig that
// the settings-backed model frame actually needs: enough to build one
// `apply-settings` intent carrying both the model and provider changes.
export type ModelSettingConfig = Readonly<{
  modelKey: string;
  providerKey: string;
  fallbackProviderKey?: string;
}>;

export type MenuFrame =
  | { id: FrameId; kind: 'slash'; binding: TextBinding }
  | { id: FrameId; kind: 'path'; binding: TextBinding }
  | {
      id: FrameId;
      kind: 'settings';
      binding: TextBinding;
      initialKey?: string;
      operation: 'set' | 'reset';
      prefix: '/settings ' | '/settings reset ';
    }
  | {
      id: FrameId;
      kind: 'settings_value';
      settingKey: string;
      binding: TextBinding;
      origin: SettingsOrigin;
    }
  | {
      id: FrameId;
      kind: 'model';
      target: { type: 'command' } | { type: 'setting'; config: ModelSettingConfig };
      binding: TextBinding;
      back: BackPolicy;
    }
  | { id: FrameId; kind: 'skills'; binding: TextBinding }
  | { id: FrameId; kind: 'copy'; items: CopySelection[] }
  | { id: FrameId; kind: 'rewind'; items: RewindItem[]; initialDisposition: RewindDisposition }
  | { id: FrameId; kind: 'providers'; returnPoint: ReturnPoint };

export type MenuState = Readonly<{
  editor: EditorSnapshot;
  stack: readonly MenuFrame[];
  resolvedCandidateIdentity: string | null;
  activationEpoch: number;
  dismissedActivation: string | null;
}>;

export type ExpectedFrame = Readonly<{ frameId: FrameId; revision: number }>;

export type FrameInput =
  | { kind: 'composer'; text: string; cursor: number }
  | { kind: 'transient'; text: string; cursor: number; sensitive: boolean }
  | { kind: 'none' };

export type TextBindingSpec = Omit<TextBinding, 'query' | 'activationId' | 'revision'>;

export type FrameSpecOf<F extends MenuFrame = MenuFrame> = F extends MenuFrame
  ? Omit<F, 'id' | 'binding'> & { binding?: TextBindingSpec }
  : never;

export type FrameSpec = FrameSpecOf;

export type UnboundFrameSpec =
  | Omit<Extract<MenuFrame, { kind: 'copy' }>, 'id'>
  | Omit<Extract<MenuFrame, { kind: 'rewind' }>, 'id'>
  | Omit<Extract<MenuFrame, { kind: 'providers' }>, 'id' | 'returnPoint'>;

export type OpenOptions = Readonly<{
  buffer?: BufferChange;
  preserveEditorAsReturnPoint?: boolean;
}>;

export type StackChange =
  | { type: 'keep' }
  | { type: 'close-top' }
  | { type: 'close-all' }
  | { type: 'push'; frame: FrameSpec }
  | { type: 'replace-top'; frame: FrameSpec }
  | { type: 'pop-to'; frameId: FrameId };

export type BufferChange =
  | { type: 'keep' }
  | { type: 'clear' }
  | { type: 'replace'; text: string; cursor: number }
  | { type: 'splice'; range: TextRange; text: string; cursor: 'after-insert' };

export type DomainIntent =
  | { type: 'submit-prompt'; text: string }
  | {
      type: 'apply-settings';
      changes: readonly { key: string; value: unknown; persistence: 'runtime' | 'restart' }[];
    }
  | { type: 'reset-setting'; key: string }
  | { type: 'rewind'; item: RewindItem; disposition: RewindDisposition }
  | { type: 'provider-save'; draft: CustomProviderDraft; originalId: string | null }
  | { type: 'provider-delete'; providerId: string }
  | { type: 'provider-reorder'; providerIds: string[] }
  | { type: 'slash-execute'; command: SlashCommand; args?: string };

export type IntentRequest = Readonly<{
  id: string;
  sourceFrameId: FrameId;
  intent: DomainIntent;
}>;

export type IntentResult =
  | { id: string; sourceFrameId: FrameId; ok: true }
  | {
      id: string;
      sourceFrameId: FrameId;
      ok: false;
      message: string;
      fieldErrors?: Readonly<Record<string, string>>;
    };

export type IntentHost = (event: {
  intentRequest: NonNullable<MenuEffect['intent']>;
}) => Promise<IntentResult> | IntentResult | void;

export type MenuEffect = Readonly<{
  buffer?: BufferChange;
  stack: StackChange;
  intent?: IntentRequest;
}>;

export type TriggerCandidate = Readonly<{
  ruleId: string;
  identity: string;
  frame: FrameSpec;
}>;

export type TriggerRule = Readonly<{
  id: string;
  priority: number;
  parse(editor: EditorSnapshot): TriggerCandidate | null;
  successors: readonly {
    ruleId: string;
    operation: 'push' | 'replace-top';
  }[];
}>;

export type EditorEdit =
  | { type: 'set-text'; text: string; cursor?: number }
  | { type: 'insert'; text: string }
  | { type: 'move-cursor'; cursor: number };

export type MenuEvent =
  | { type: 'move'; direction: 'up' | 'down' | 'home' | 'end' | 'page-up' | 'page-down' }
  | {
      type: 'command';
      command: 'tab' | 'left' | 'right' | 'refresh' | 'reset' | 'backspace' | 'delete' | 'reorder-up' | 'reorder-down';
    }
  | { type: 'input'; text: string }
  | { type: 'accept'; input: FrameInput; selected: unknown | undefined }
  | { type: 'escape' };

export type MenuInteraction = Readonly<{
  handle(event: MenuEvent | IntentResult): MenuEffect | 'fallthrough' | void;
}>;

export interface MenuInteractionRegistry {
  register(frameId: FrameId, interaction: MenuInteraction): () => void;
  dispatch(frameId: FrameId, event: MenuEvent | IntentResult): ReturnType<MenuInteraction['handle']>;
}

export type ProviderSessionState =
  | { phase: 'list'; items: ProviderSelectionItem[] }
  | {
      phase: 'wizard-name' | 'wizard-url' | 'wizard-key';
      draft: CustomProviderDraft;
      editingField: ProviderField | null;
      modified: boolean;
    }
  | { phase: 'wizard-type'; draft: CustomProviderDraft; editingField: ProviderField | null }
  | { phase: 'edit-fields'; draft: CustomProviderDraft; originalId: string }
  | { phase: 'confirm-discard'; resume: ProviderSessionState }
  | { phase: 'confirm-delete'; providerId: string }
  | { phase: 'reorder'; providerIds: string[] };

export interface MenuCapability {
  open(frame: UnboundFrameSpec, options?: OpenOptions): void;
  replace(frame: FrameSpec, options?: OpenOptions): void;
  close(): void;
  closeAll(): void;
}

export interface MenuController extends MenuCapability {
  getSnapshot(): MenuState;

  applyEditorEdit(edit: EditorEdit): void;
  replaceText(text: string, cursor?: number): void;
  clearText(): void;

  dispatch(effect: MenuEffect, expected: ExpectedFrame): void;
  dispatchActiveEvent(event: MenuEvent): void;
  escape(): void;

  getInteractionRegistry(): MenuInteractionRegistry;
  setTriggerRegistry(registry: TriggerRuleRegistry): void;
  setIntentHost(host?: IntentHost): void;

  subscribe(listener: () => void): () => void;
}
