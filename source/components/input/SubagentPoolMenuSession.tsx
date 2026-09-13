import React, { useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../../context/InputContext.js';
import { SETTING_KEYS } from '../../services/settings/settings-service.js';
import { useSubagentPoolSelection } from '../../hooks/use-subagent-pool-selection.js';
import { getSubagentPoolFallbackProviderKey } from '../../services/subagents/subagent-pool-config.js';
import SubagentPoolSelectionMenu from '../menu/SubagentPoolSelectionMenu.js';
import ModelSelectionMenu from '../menu/ModelSelectionMenu.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuEvent, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'subagent_pool' }>>;

export function SubagentPoolMenuSession({ frame, active, controller, interactions, services }: Props) {
  const { setMenuPromptLabel } = useInputContext();
  const settingsService = services.settingsService as
    | import('../../services/settings/settings-service.js').SettingsService
    | undefined;
  if (!settingsService) throw new Error('SubagentPoolMenuSession requires settingsService');
  const loggingService = services.loggingService as
    | import('../../services/service-interfaces.js').ILoggingService
    | undefined;
  const poolKind: 'fanout' | 'round-robin' =
    frame.settingKey === SETTING_KEYS.AGENT_MENTOR_POOL ? 'fanout' : 'round-robin';
  const pool = useSubagentPoolSelection(settingsService, active, loggingService, {
    settingKey: frame.settingKey,
    roleLabel: frame.roleLabel,
    entryShape: frame.entryShape,
    fallbackProviderKey: getSubagentPoolFallbackProviderKey(frame.settingKey),
  });
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setMenuPromptLabel(pool.phase === 'edit_model' ? 'Search models or enter a custom ID: ' : undefined);
    return () => setMenuPromptLabel(undefined);
  }, [active, pool.phase, setMenuPromptLabel]);

  const interaction = useMemo<MenuInteraction>(() => {
    const keep = (): MenuEffect => ({ stack: { type: 'keep' } });
    const textFromInput = (event: Extract<MenuEvent, { type: 'accept' }>): string =>
      event.input.kind === 'none' ? '' : event.input.text;
    const save = (): MenuEffect | 'fallthrough' => {
      const effect = pool.saveIntent(frame.id);
      return effect ?? keep();
    };

    return {
      handle: (event) => {
        if (!('type' in event)) {
          if (event.ok) return { stack: { type: 'close-top' } };
          setApplyError(event.fieldErrors?.[frame.settingKey] ?? event.message);
          return keep();
        }

        const editingModel = pool.phase === 'edit_model';
        // The pool's model picker uses the unified Favorites/All model view.
        // Provider is taken from the selected row rather than from a provider tab.
        if (editingModel && applyMenuEditorEvent(controller, event, { horizontal: false })) {
          return keep();
        }

        switch (event.type) {
          case 'move':
            if (editingModel) {
              if (event.direction === 'up') pool.moveModelUp();
              else if (event.direction === 'down') pool.moveModelDown();
              else if (event.direction === 'home') pool.moveModelHome();
              else if (event.direction === 'end') pool.moveModelEnd();
              else if (event.direction === 'page-up') pool.pageModelUp();
              else pool.pageModelDown();
            } else if (event.direction === 'up') pool.moveUp();
            else if (event.direction === 'down') pool.moveDown();
            else if (event.direction === 'home') pool.moveHome();
            else if (event.direction === 'end') pool.moveEnd();
            else if (event.direction === 'page-up') pool.pageUp();
            else pool.pageDown();
            return keep();
          case 'command':
            if (editingModel && (event.command === 'tab' || event.command === 'left' || event.command === 'right')) {
              pool.switchModelTab();
            } else if (editingModel && event.command === 'refresh') {
              pool.refreshModels();
            } else if (event.command === 'delete') {
              pool.requestDelete();
            }
            return keep();
          case 'accept':
            setApplyError(null);
            if (editingModel) {
              pool.selectModel(textFromInput(event));
            } else {
              const selected = pool.getSelectedItem();
              if (pool.phase === 'list' && selected?.kind === 'action' && selected.action === 'save') return save();
              pool.selectItem();
            }
            return keep();
          case 'escape':
            setApplyError(null);
            if (pool.phase === 'list') return save();
            pool.goBack();
            return keep();
          default:
            return;
        }
      },
    };
  }, [controller, frame.id, frame.settingKey, pool]);

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  if (pool.phase === 'edit_model') {
    return (
      <ModelSelectionMenu
        settingsService={settingsService}
        items={pool.filteredModels}
        selectedIndex={pool.modelSelectedIndex}
        query={pool.modelQuery}
        modelTab={pool.modelTab}
        loading={pool.modelLoading}
        error={pool.modelError}
        scrollOffset={pool.modelScrollOffset}
        canSwitchProvider={true}
      />
    );
  }
  return (
    <SubagentPoolSelectionMenu
      phase={pool.phase}
      selectedIndex={pool.selectedIndex}
      activeItems={pool.activeItems}
      draft={pool.draft}
      errorMessage={pool.errorMessage ?? applyError}
      fieldErrors={pool.fieldErrors}
      roleLabel={frame.roleLabel}
      poolKind={poolKind}
      entryShape={frame.entryShape}
    />
  );
}
