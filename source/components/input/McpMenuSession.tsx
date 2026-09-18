import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInputContext } from '../../context/InputContext.js';
import type { McpConfigController, RawMcpServerConfig } from '../../services/mcp/mcp-config-controller.js';
import type { McpConnectionManager } from '../../services/mcp/mcp-connection-manager.js';
import type { McpServerSnapshot } from '../../services/mcp/mcp-tool-source.js';
import { McpSelectionMenu, type McpMenuItem } from '../menu/McpSelectionMenu.js';
import { applyMenuEditorEvent } from './menu-editor.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'mcp' }>>;
type Phase = 'list' | 'detail' | 'form' | 'confirm-delete';
type Field =
  | 'name'
  | 'type'
  | 'command'
  | 'url'
  | 'args'
  | 'cwd'
  | 'env'
  | 'headers'
  | 'clientId'
  | 'clientMetadataUrl'
  | 'redirectPorts';
type Draft = {
  originalName: string | null;
  name: string;
  config: RawMcpServerConfig;
  maskedFields: ReadonlySet<Field>;
};
type PendingIntent = { type: 'save'; name: string } | { type: 'delete' } | { type: 'refresh' };
type Item = McpMenuItem &
  (
    | { kind: 'server'; name: string }
    | { kind: 'add' }
    | { kind: 'field'; field: Field }
    | { kind: 'action'; action: string }
  );

const jsonFields = new Set<Field>(['args', 'env', 'headers', 'redirectPorts']);
const fieldLabel: Record<Field, string> = {
  name: 'Name',
  type: 'Transport',
  command: 'Command',
  url: 'URL',
  args: 'Arguments (JSON array)',
  cwd: 'Working directory',
  env: 'Environment (JSON object)',
  headers: 'Headers (JSON object)',
  clientId: 'OAuth client ID',
  clientMetadataUrl: 'Client metadata URL',
  redirectPorts: 'OAuth redirect ports (JSON array)',
};

const transportOf = (config: RawMcpServerConfig): 'stdio' | 'http' | 'sse' =>
  config.type === 'sse'
    ? 'sse'
    : config.type === 'http' || (config.url !== undefined && config.command === undefined)
    ? 'http'
    : 'stdio';

const displayValue = (field: Field, draft: Draft): string => {
  if (field === 'name') return draft.name || 'required';
  if (field === 'type') return transportOf(draft.config);
  const value = draft.config[field];
  if (draft.maskedFields.has(field)) return value === undefined || value === '' ? '<none>' : '<configured>';
  if (value === undefined || value === '') return '<none>';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const formFields = (draft: Draft): Field[] => {
  const type = transportOf(draft.config);
  return type === 'stdio'
    ? ['name', 'type', 'command', 'args', 'cwd', 'env']
    : ['name', 'type', 'url', 'headers', 'clientId', 'clientMetadataUrl', 'redirectPorts'];
};

const normalizedConfig = (draft: Draft): RawMcpServerConfig => {
  const type = transportOf(draft.config);
  const config: RawMcpServerConfig = { ...draft.config, type };
  if (type === 'stdio') {
    delete config.url;
    if (typeof config.command !== 'string' || !config.command.trim()) {
      throw new Error('Command is required for a stdio server.');
    }
  } else {
    delete config.command;
    delete config.args;
    delete config.cwd;
    delete config.env;
    if (typeof config.url !== 'string' || !config.url.trim()) {
      throw new Error('URL is required for an HTTP or SSE server.');
    }
    try {
      new URL(config.url);
    } catch {
      throw new Error('URL must be an absolute URL.');
    }
  }
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== ''));
};

export function McpMenuSession({ frame, active, controller, interactions, services }: Props) {
  const manager = services.mcpManager as McpConnectionManager;
  const configController = services.mcpConfigController as McpConfigController;
  const { setMenuPromptLabel } = useInputContext();
  const [phase, setPhase] = useState<Phase>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [snapshots, setSnapshots] = useState<readonly McpServerSnapshot[]>(manager.snapshot());
  const [userConfigs, setUserConfigs] = useState<readonly { name: string; config: RawMcpServerConfig }[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingField, setEditingField] = useState<Field | null>(null);
  const [error, setError] = useState<string>();
  const pendingIntents = useRef(new Map<string, PendingIntent>());

  const refresh = useCallback(async () => {
    setSnapshots(manager.snapshot());
    setUserConfigs(await configController.listUserServers());
  }, [configController, manager]);
  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return manager.onCatalogChanged(() => setSnapshots(manager.snapshot()));
  }, [manager, refresh]);
  useEffect(() => {
    if (!active) return;
    setMenuPromptLabel(editingField ? `${fieldLabel[editingField]}: ` : undefined);
    return () => setMenuPromptLabel(undefined);
  }, [active, editingField, setMenuPromptLabel]);

  const selectedSnapshot = snapshots.find((server) => server.name === selectedName);
  const isUser = userConfigs.some((entry) => entry.name === selectedName);
  const items = useMemo<Item[]>(() => {
    if (phase === 'list')
      return [
        ...snapshots.map((server) => ({
          kind: 'server' as const,
          id: server.name,
          name: server.name,
          label: server.name,
          detail: `${server.state} · ${server.tools.length} tools · ${server.provenance} ${server.transport}`,
          ...(server.state === 'failed'
            ? { tone: 'danger' as const }
            : server.state === 'needs-auth'
            ? { tone: 'warning' as const }
            : {}),
        })),
        { kind: 'add', id: 'add', label: '+ Add user server' },
      ];
    if (phase === 'detail') {
      const out: Item[] = [];
      if (isUser) out.push({ kind: 'action', id: 'edit', action: 'edit', label: 'Edit configuration' });
      out.push({ kind: 'action', id: 'reconnect', action: 'reconnect', label: 'Reconnect now' });
      if (selectedName && manager.oauthTarget(selectedName))
        out.push({ kind: 'action', id: 'login', action: 'login', label: 'Log in with OAuth' });
      if (isUser)
        out.push({ kind: 'action', id: 'delete', action: 'delete', label: 'Delete user server', tone: 'danger' });
      out.push({ kind: 'action', id: 'back', action: 'back', label: 'Back' });
      return out;
    }
    if (phase === 'confirm-delete')
      return [
        { kind: 'action', id: 'confirm', action: 'confirm-delete', label: `Delete ${selectedName}?`, tone: 'danger' },
        { kind: 'action', id: 'cancel', action: 'cancel-delete', label: 'Cancel' },
      ];
    if (!draft) return [];
    return [
      ...formFields(draft).map((field) => ({
        kind: 'field' as const,
        id: field,
        field,
        label: fieldLabel[field],
        detail: displayValue(field, draft),
      })),
      { kind: 'action', id: 'save', action: 'save', label: 'Save and reload', tone: 'warning' },
      { kind: 'action', id: 'cancel', action: 'cancel-form', label: 'Cancel' },
    ];
  }, [draft, isUser, manager, phase, selectedName, snapshots]);

  useEffect(() => setSelectedIndex((index) => Math.min(index, Math.max(0, items.length - 1))), [items.length]);
  const enterForm = (entry?: { name: string; config: RawMcpServerConfig }) => {
    setDraft(
      entry
        ? {
            originalName: entry.name,
            name: entry.name,
            config: { ...entry.config },
            maskedFields: new Set(
              Object.keys(entry.config).filter((field): field is Field => field !== 'type' && field in fieldLabel),
            ),
          }
        : { originalName: null, name: '', config: { type: 'stdio' }, maskedFields: new Set() },
    );
    setPhase('form');
    setSelectedIndex(0);
    setError(undefined);
  };
  const back = () => {
    if (editingField) {
      setEditingField(null);
      controller.clearText();
      return;
    }
    if (phase === 'list') {
      controller.close();
      return;
    }
    setPhase(phase === 'form' && selectedName ? 'detail' : 'list');
    setSelectedIndex(0);
    setError(undefined);
  };

  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        const keep = (): MenuEffect => ({ stack: { type: 'keep' } });
        if (!('type' in event)) {
          const pending = pendingIntents.current.get(event.id);
          if (!pending) return keep();
          pendingIntents.current.delete(event.id);
          if (!event.ok) {
            setError(event.message);
            return keep();
          }
          setError(undefined);
          if (pending.type === 'save' || pending.type === 'delete') {
            void refresh()
              .then(() => {
                setSelectedName(pending.type === 'save' ? pending.name : null);
                setPhase(pending.type === 'save' ? 'detail' : 'list');
                setSelectedIndex(0);
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }
          return keep();
        }
        if (editingField) {
          if (
            event.type === 'input' ||
            (event.type === 'command' && ['left', 'right', 'backspace', 'delete'].includes(event.command))
          ) {
            applyMenuEditorEvent(controller, event);
            return keep();
          }
          if (event.type === 'accept' && draft) {
            const text = event.input.kind === 'none' ? '' : event.input.text;
            try {
              if (draft.maskedFields.has(editingField) && text === '') {
                setEditingField(null);
                controller.clearText();
                return keep();
              }
              const value =
                text === '<clear>' ? undefined : jsonFields.has(editingField) && text ? JSON.parse(text) : text;
              if (
                editingField === 'args' &&
                value !== undefined &&
                (!Array.isArray(value) || value.some((x) => typeof x !== 'string'))
              )
                throw new Error('Arguments must be a JSON array of strings.');
              if (
                (editingField === 'env' || editingField === 'headers') &&
                value !== undefined &&
                (typeof value !== 'object' ||
                  value === null ||
                  Array.isArray(value) ||
                  Object.values(value).some((x) => typeof x !== 'string'))
              )
                throw new Error(`${fieldLabel[editingField]} must be a JSON object of strings.`);
              if (
                editingField === 'redirectPorts' &&
                value !== undefined &&
                (!Array.isArray(value) || value.some((x) => !Number.isInteger(x) || x < 1 || x > 65535))
              )
                throw new Error('Redirect ports must be a JSON array of port numbers.');
              if (editingField === 'name') setDraft({ ...draft, name: text });
              else {
                const maskedFields = new Set(draft.maskedFields);
                maskedFields.delete(editingField);
                setDraft({ ...draft, config: { ...draft.config, [editingField]: value || undefined }, maskedFields });
              }
              setEditingField(null);
              controller.clearText();
              setError(undefined);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
            return keep();
          }
          if (event.type === 'escape') {
            back();
            return keep();
          }
          return keep();
        }
        if (event.type === 'move') {
          setSelectedIndex((i) =>
            event.direction === 'up'
              ? Math.max(0, i - 1)
              : event.direction === 'down'
              ? Math.min(items.length - 1, i + 1)
              : i,
          );
          return keep();
        }
        if (event.type === 'escape') {
          back();
          return keep();
        }
        if (event.type !== 'accept') return keep();
        const item = items[selectedIndex];
        if (!item) return keep();
        if (item.kind === 'server') {
          setSelectedName(item.name);
          setPhase('detail');
          setSelectedIndex(0);
        } else if (item.kind === 'add') {
          setSelectedName(null);
          enterForm();
        } else if (item.kind === 'field' && draft) {
          if (item.field === 'type') {
            const current = transportOf(draft.config);
            const next = current === 'stdio' ? 'http' : current === 'http' ? 'sse' : 'stdio';
            setDraft({ ...draft, config: { ...draft.config, type: next } });
          } else {
            setEditingField(item.field);
            const existing = item.field === 'name' ? draft.name : draft.config[item.field];
            controller.replaceText(
              draft.maskedFields.has(item.field)
                ? ''
                : existing === undefined
                ? ''
                : typeof existing === 'string'
                ? existing
                : JSON.stringify(existing),
            );
          }
        } else if (item.kind === 'action') {
          if (item.action === 'back' || item.action === 'cancel-form' || item.action === 'cancel-delete') back();
          else if (item.action === 'edit') {
            const entry = userConfigs.find((x) => x.name === selectedName);
            if (entry) enterForm(entry);
          } else if (item.action === 'delete') {
            setPhase('confirm-delete');
            setSelectedIndex(0);
          } else if (item.action === 'reconnect' && selectedName) {
            const id = `mcp-reconnect:${frame.id}:${selectedName}`;
            pendingIntents.current.set(id, { type: 'refresh' });
            return {
              stack: { type: 'keep' },
              intent: { id, sourceFrameId: frame.id, intent: { type: 'mcp-reconnect', serverName: selectedName } },
            };
          } else if (item.action === 'login' && selectedName) {
            const id = `mcp-login:${frame.id}:${selectedName}`;
            pendingIntents.current.set(id, { type: 'refresh' });
            return {
              stack: { type: 'keep' },
              intent: { id, sourceFrameId: frame.id, intent: { type: 'mcp-login', serverName: selectedName } },
            };
          } else if (item.action === 'confirm-delete' && selectedName) {
            const id = `mcp-delete:${frame.id}:${selectedName}`;
            pendingIntents.current.set(id, { type: 'delete' });
            return {
              stack: { type: 'keep' },
              intent: { id, sourceFrameId: frame.id, intent: { type: 'mcp-delete', serverName: selectedName } },
            };
          } else if (item.action === 'save' && draft) {
            try {
              const config = normalizedConfig(draft);
              const name = draft.name.trim();
              const id = `mcp-save:${frame.id}:${draft.originalName ?? 'new'}:${name}`;
              pendingIntents.current.set(id, { type: 'save', name });
              return {
                stack: { type: 'keep' },
                intent: {
                  id,
                  sourceFrameId: frame.id,
                  intent: { type: 'mcp-save', originalName: draft.originalName, name, config },
                },
              };
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }
        }
        return keep();
      },
    }),
    [controller, draft, editingField, items, manager, phase, refresh, selectedIndex, selectedName, userConfigs],
  );
  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);
  if (!active) return null;
  const title =
    phase === 'list'
      ? 'MCP Server Management'
      : phase === 'detail'
      ? `MCP Server: ${selectedName}`
      : phase === 'confirm-delete'
      ? 'Confirm MCP Server Deletion'
      : draft?.originalName
      ? `Edit MCP Server: ${draft.originalName}`
      : 'Add MCP Server';
  return (
    <McpSelectionMenu
      title={title}
      items={items}
      selectedIndex={selectedIndex}
      error={error ?? selectedSnapshot?.error}
      editing={editingField !== null}
    />
  );
}
