/** Plain-output formatting shared by the old headless CLI and this client. */
import type { WireEventPayloads, WireInteraction, WireTool } from '../../protocol/wire.js';

const safePreview = (value: unknown, maxLength = 500): string => {
  try {
    if (typeof value === 'string') {
      return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
    }
    const json = JSON.stringify(value);
    if (!json) return '';
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return '';
  }
};

/** Old stderr tool line: `[tool] shell: ls` for the well-known argument shapes. */
export function formatToolSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return `[tool] ${toolName}`;
  }
  const values = input as Record<string, unknown>;
  if (toolName === 'shell' || toolName === 'bash') {
    if (typeof values['command'] === 'string') {
      return `[tool] ${toolName}: ${safePreview(values['command'], 80)}`;
    }
  }
  if (
    ['read_file', 'create_file', 'write_to_file', 'replace_file_content', 'search_replace', 'apply_patch'].includes(
      toolName,
    )
  ) {
    const file = values['TargetFile'] ?? values['targetFile'] ?? values['path'] ?? values['filePath'] ?? values['file'];
    if (typeof file === 'string') return `[tool] ${toolName}: ${file}`;
  }
  if (toolName === 'grep_search' || toolName === 'search_web') {
    const query = values['Query'] ?? values['query'];
    if (typeof query === 'string') return `[tool] ${toolName}: ${safePreview(query, 60)}`;
  }
  if (toolName === 'find_by_name' || toolName === 'list_dir') {
    const target = values['Pattern'] ?? values['DirectoryPath'] ?? values['path'] ?? values['SearchPath'];
    if (typeof target === 'string') return `[tool] ${toolName}: ${target}`;
  }
  const firstString = Object.values(values).find((value) => typeof value === 'string');
  if (typeof firstString === 'string') return `[tool] ${toolName}: ${safePreview(firstString, 60)}`;
  return `[tool] ${toolName}`;
}

export function toolStartLine(tool: WireTool): string {
  return `${formatToolSummary(tool.toolName, tool.input)}\n`;
}

/** Approval lines match the existing stderr wording; questions have no old headless presenter. */
export function interactionLine(interaction: WireInteraction): string {
  if (interaction.kind === 'approval') return `[approval required] ${interaction.toolName}\n`;
  const summary = interaction.summary ? ` ${interaction.summary}` : '';
  return `[question] ${interaction.toolName}${summary}\n`;
}

export function rejectionLine(reason: string | undefined): string {
  return `Approval Rejected: ${reason ?? 'No reason provided'}\n`;
}

/** Old retry wording when the protocol supplies the metadata; explicit fallback otherwise. */
export function retryLine(payload: WireEventPayloads['retrying'], agentId?: string): string {
  if (agentId === undefined && payload.retryType === 'flex_service_tier') {
    return `[retry] service_tier: ${payload.error.message}\n`;
  }
  const label = agentId === undefined ? '[retry]' : `[subagent ${agentId} retry]`;
  if (payload.toolName !== undefined && payload.maxRetries !== undefined) {
    return `${label} ${payload.toolName} (${payload.attempt}/${payload.maxRetries}): ${payload.error.message}\n`;
  }
  return `${label} attempt ${payload.attempt} in ${payload.delayMs}ms: ${payload.error.message}\n`;
}
