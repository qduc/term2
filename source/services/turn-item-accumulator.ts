import type { NormalizedUsage } from '../utils/token-usage.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';

export class TurnItemAccumulator {
  private items: PersistedAssistantTurnItem[] = [];
  private reasoningBuffer = '';
  private assistantTextBuffer = '';
  private displayUsage: NormalizedUsage | undefined;

  flushReasoningItem(): void {
    if (this.reasoningBuffer) {
      this.items.push({ type: 'reasoning', text: this.reasoningBuffer });
      this.reasoningBuffer = '';
    }
  }

  flushAssistantTextItem(): void {
    if (this.assistantTextBuffer) {
      this.items.push({ type: 'assistant_text', text: this.assistantTextBuffer });
      this.assistantTextBuffer = '';
    }
  }

  recordToolCallItem(callId: string, toolName: string, args: unknown): void {
    this.flushReasoningItem();
    this.flushAssistantTextItem();
    this.items.push({ type: 'tool_call', callId, toolName, arguments: args });
  }

  recordToolResultItem(
    callId: string,
    toolName: string,
    status: 'completed' | 'failed' | 'aborted',
    output: unknown,
  ): void {
    this.flushReasoningItem();
    this.flushAssistantTextItem();
    this.items.push({ type: 'tool_result', callId, toolName, status, output });
  }

  resetPersistedTurnState(): void {
    this.items = [];
    this.reasoningBuffer = '';
    this.assistantTextBuffer = '';
    this.displayUsage = undefined;
  }

  getTurnItems(): PersistedAssistantTurnItem[] {
    return this.items;
  }

  getDisplayUsage(): NormalizedUsage | undefined {
    return this.displayUsage;
  }

  setDisplayUsage(usage: NormalizedUsage): void {
    this.displayUsage = usage;
  }

  appendTextDelta(delta: string): void {
    this.assistantTextBuffer += delta;
  }

  appendReasoningDelta(delta: string): void {
    this.reasoningBuffer += delta;
  }

  hasReasoningBuffer(): boolean {
    return this.reasoningBuffer.length > 0;
  }

  hasTextBuffer(): boolean {
    return this.assistantTextBuffer.length > 0;
  }
}
