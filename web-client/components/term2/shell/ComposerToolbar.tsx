'use client';

import { memo, useCallback, type RefObject } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { openSettings } from '../../../lib/term2/navigation';
import { shallowEqual } from '../../../lib/term2/store';
import { Term2ApprovalPicker } from '../Term2ApprovalPicker';
import { Term2CommandMenu } from '../Term2CommandMenu';
import { Term2SkillsPopover } from '../Term2ComposerPopovers';
import { Term2ModelPicker } from '../Term2ModelPicker';
import { Term2UsagePopover } from '../Term2UsagePopover';
import { useChatFacts, useSessionView, useShell, useShellState } from './ShellContext';

/** Under the message box: skills and commands, the model and approval pickers, usage, and send/steer/stop. */
export const ComposerToolbar = memo(function ComposerToolbar({
  composerRef,
  skillPickedRef,
  onAttachImage,
  onMentionFile,
}: {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  skillPickedRef: RefObject<boolean>;
  onAttachImage: () => void;
  onMentionFile: () => void;
}) {
  const shell = useShell();
  const { dispatch, ops, session } = shell;
  const skillsOpen = useShellState((s) => s.panels.skills);
  const armedSkill = useShellState((s) => s.composer.armedSkill);
  const hasContent = useShellState((s) => Boolean(s.composer.input.trim()) || s.composer.attachments.length > 0);
  const f = useChatFacts(
    (facts) => ({
      composerDisabled: facts.composerDisabled,
      commandDisabled: facts.commandDisabled,
      commandPending: facts.commandPending,
      commandNotice: facts.commandNotice,
      pickerConfig: facts.pickerConfig,
      pickerDisabled: facts.pickerDisabled,
      pickerNote: facts.pickerNote,
      pickerWarning: facts.pickerWarning,
      staged: Boolean(facts.stagedForChat),
      sendBlocked: facts.sendBlocked,
      streaming: facts.canAbort && facts.hasStreamingTurn,
    }),
    shallowEqual,
  );
  const skills = useStoreSelector(shell.data.skills, (s) => s);
  const models = useStoreSelector(shell.data.models, (s) => s);
  const settings = useStoreSelector(shell.data.settings, (s) => s.data);
  const configBusy = useStoreSelector(shell.local, (l) => l.configBusy);
  const { pickerConfig } = f;
  const handleSelectModel = useCallback(
    (provider: string, model: string) => void ops.updateSessionConfig({ modelSelection: { provider, model } }),
    [ops],
  );
  const handleSelectEffort = useCallback(
    (reasoningEffort: NonNullable<Parameters<typeof ops.updateSessionConfig>[0]['reasoningEffort']>) =>
      void ops.updateSessionConfig({ reasoningEffort }),
    [ops],
  );
  const handleToggleFavorite = useCallback((key: string) => void ops.toggleFavorite(key), [ops]);
  const handleRefreshModels = useCallback(() => void shell.data.models.load(), [shell.data.models]);
  const handleOpenSettings = useCallback(() => openSettings(), []);

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1 text-xs text-zinc-500 dark:text-zinc-400">
      <Popover
        open={skillsOpen}
        onOpenChange={(open) => {
          if (open) ops.toggleSkills();
          else dispatch({ type: 'SKILLS_SET', open: false });
        }}
      >
        <PopoverAnchor asChild>
          <div className="min-w-0">
            <Term2CommandMenu
              composerDisabled={f.composerDisabled}
              commandsDisabled={f.commandDisabled}
              pending={f.commandPending}
              notice={f.commandNotice}
              onAttachImage={onAttachImage}
              onMentionFile={onMentionFile}
              onUseSkill={ops.toggleSkills}
              onCommand={(commandId) => void session.invokeCommand(commandId)}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          aria-label="Choose a skill"
          className="max-h-72 w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-1 scrollbar-thin"
          onCloseAutoFocus={(event) => {
            // Picking a skill hands focus to the composer rather than back to the trigger.
            if (!skillPickedRef.current) return;
            skillPickedRef.current = false;
            event.preventDefault();
            composerRef.current?.focus();
          }}
        >
          <Term2SkillsPopover
            skills={skills.data}
            loading={skills.loading}
            selectedSkill={armedSkill}
            onSelect={(skill) => {
              dispatch({ type: 'COMPOSER_EDITED', patch: { armedSkill: skill ? skill.name : null } });
              skillPickedRef.current = true;
              dispatch({ type: 'SKILLS_SET', open: false });
              composerRef.current?.focus();
            }}
          />
        </PopoverContent>
      </Popover>

      {pickerConfig && (
        <>
          <Term2ModelPicker
            config={pickerConfig}
            models={models.data}
            loadingModels={models.loading}
            settings={settings}
            disabled={f.pickerDisabled}
            busy={configBusy}
            onSelectModel={handleSelectModel}
            onSelectEffort={handleSelectEffort}
            onToggleFavorite={settings ? handleToggleFavorite : undefined}
            onRefreshModels={handleRefreshModels}
            onOpenSettings={handleOpenSettings}
            pending={f.staged}
            note={f.pickerNote}
            warning={f.pickerWarning}
          />
          <Term2ApprovalPicker
            mode={pickerConfig.approvalMode ?? 'off'}
            disabled={f.pickerDisabled}
            busy={configBusy}
            onSelect={(approvalMode) => void ops.updateSessionConfig({ approvalMode })}
          />
        </>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <UsageChip canCompact={!f.commandDisabled} />

        {f.streaming && hasContent && (
          <>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void ops.send('follow_up')}
              title="Queue message for after this turn (Alt+Enter)"
              className="rounded-full"
            >
              Queue
            </Button>
            <Button
              type="button"
              size="xs"
              onClick={() => void ops.send('steer')}
              title="Steer the active turn immediately (Enter)"
              className="rounded-full"
            >
              Steer
            </Button>
          </>
        )}

        {f.streaming ? (
          <Button
            type="button"
            size="icon"
            aria-label="Stop agent turn"
            title="Stop"
            className="rounded-full"
            onClick={() => void session.abort()}
          >
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            aria-label="Send message"
            title="Send (Enter) · new line (Shift+Enter)"
            className="rounded-full"
            disabled={f.composerDisabled || f.sendBlocked || !hasContent}
            onClick={() => void ops.send()}
          >
            <ArrowUp strokeWidth={2.25} />
          </Button>
        )}
      </div>
    </div>
  );
});

/** The usage popover reads the whole view; it subscribes on its own so a stream frame re-renders only it. */
function UsageChip({ canCompact }: { canCompact: boolean }) {
  const shell = useShell();
  const view = useSessionView((v) => v);
  const config = useChatFacts((f) => f.sessionConfig);
  const models = useStoreSelector(shell.data.models, (s) => s.data);
  return (
    <Term2UsagePopover
      view={view}
      config={config}
      models={models}
      canCompact={canCompact}
      onCompact={() => void shell.session.invokeCommand('compact')}
    />
  );
}
