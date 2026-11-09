import type * as acp from '@agentclientprotocol/sdk';

export type V1Display = {
  readonly cwd: string;
  readonly capabilities?: acp.InitializeRequest['clientCapabilities'];
};

type Tool = Extract<acp.SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
type Terminal = { readonly id: string; output: string; ended: boolean };

/**
 * Agent-owned terminal display via the opt-in Air/Zed metadata convention.
 * This never creates a client process or changes native execution policy.
 * Full native output upserts become one suffix per terminal; fresh attachments
 * get fresh state so load replays output, while repeated snapshots do not.
 */
export class V1Terminals {
  private readonly terminals = new Map<string, Terminal>();
  private readonly channel: 'terminal_output_delta' | 'terminal_output' | undefined;

  constructor(private readonly display: V1Display) {
    const meta = display.capabilities?._meta;
    this.channel =
      meta?.terminal_output_delta === true
        ? 'terminal_output_delta'
        : meta?.terminal_output === true
        ? 'terminal_output'
        : undefined;
  }

  translate(sessionId: string, tool: Tool): Tool[] {
    if (!this.channel) return [tool];
    const key = JSON.stringify([sessionId, tool.toolCallId]);
    let terminal = this.terminals.get(key);
    if (!terminal && tool.kind !== 'execute') return [tool];
    const fresh = !terminal;
    if (!terminal) {
      terminal = { id: tool.toolCallId, output: '', ended: false };
      this.terminals.set(key, terminal);
    }
    if (terminal.ended) return [];
    const content = tool.content ?? [];
    const text = content
      .flatMap((part) => (part.type === 'content' && part.content.type === 'text' ? [part.content.text] : []))
      .join('');
    const data = text.startsWith(terminal.output)
      ? text.slice(terminal.output.length)
      : text && text !== terminal.output
      ? `\n${text}`
      : '';
    // Later upserts may omit content entirely; omission never clears output.
    if (text) terminal.output = text;
    const complete = tool.status === 'completed' || tool.status === 'failed';
    const meta: Record<string, unknown> = {
      ...tool._meta,
      terminal_info: { cwd: this.display.cwd, terminal_id: terminal.id },
    };
    if (data && !terminal.ended) meta[this.channel] = { terminal_id: terminal.id, data };
    const report: Tool = {
      ...tool,
      content: [
        { type: 'terminal', terminalId: terminal.id },
        ...content.filter((part) => part.type !== 'content' || part.content.type !== 'text'),
      ],
      _meta: meta,
    };
    if (!complete || terminal.ended) return [report];
    terminal.ended = true;
    // Deliver terminal data before its closing status, including completed calls
    // first encountered during load. Never invent a numeric process exit code.
    const finish: Tool = {
      sessionUpdate: 'tool_call_update',
      toolCallId: tool.toolCallId,
      status: tool.status,
      _meta: {
        terminal_info: meta.terminal_info,
        terminal_exit: { terminal_id: terminal.id, exit_code: null, signal: null },
      },
    };
    return [{ ...report, status: fresh ? 'in_progress' : undefined }, finish];
  }
}
