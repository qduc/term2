import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

export const formatToolArgs = (
  toolName: string | undefined,
  args: any,
  displayMode?: 'standard' | 'concise',
): string => {
  if (!args || !toolName) {
    return '';
  }

  const normalizedArgs: any = (() => {
    if (typeof args !== 'string') {
      return args;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  })();

  if (!normalizedArgs || typeof normalizedArgs !== 'object') {
    return '';
  }

  try {
    // Format based on tool type to match extract-command-messages.ts
    switch (toolName) {
      case 'shell': {
        const command = normalizedArgs.command ?? normalizedArgs.commands;

        const commandText = typeof command === 'string' ? command : Array.isArray(command) ? command.join(' && ') : '';

        if (typeof commandText === 'string' && commandText.trim()) {
          return commandText.length > 80 ? `${commandText.slice(0, 80)}...` : commandText;
        }
        return '';
      }

      case 'grep': {
        const pattern = normalizedArgs.pattern || '';
        const path = normalizedArgs.path || '.';
        const parts = [`for "${pattern}" in "${path}"`];
        if (normalizedArgs.fixed_strings) parts.push('--fixed-strings');
        if (normalizedArgs.ignore_case) parts.push('--ignore-case');
        if (normalizedArgs.include) parts.push(`--include "${normalizedArgs.include}"`);
        if (normalizedArgs.exclude) parts.push(`--exclude "${normalizedArgs.exclude}"`);
        return parts.join(' ');
      }

      case 'read_file':
      case 'view_file': {
        const path = normalizedArgs.path || 'unknown';
        const start = normalizedArgs.start_line;
        const end = normalizedArgs.end_line;
        if (start !== undefined || end !== undefined) {
          return `"${path}" (lines ${start ?? 1}-${end ?? 'end'})`;
        }
        return `"${path}"`;
      }

      case 'glob': {
        const pattern = normalizedArgs.pattern || '';
        const path = normalizedArgs.path || '.';
        if (path !== '.' && path) {
          return `matching "${pattern}" in "${path}"`;
        }
        return `matching "${pattern}"`;
      }

      case 'run_subagent': {
        const role = normalizedArgs.role || 'subagent';
        const task = normalizedArgs.task || '';
        const taskPreview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
        return `[${role}] "${taskPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'run_subagent_async': {
        const role = normalizedArgs.role || 'subagent';
        const task = normalizedArgs.task || '';
        const taskPreview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
        return `[${role}] "${taskPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'get_subagent_result': {
        const runId = normalizedArgs.runId || 'unknown';
        return `[${runId}]`;
      }

      case 'get_subagent_status': {
        // runId is optional; strict OpenAI schemas send an omitted optional as null, so
        // `||` (not `??`) is what keeps an all-runs peek from rendering as `runId=null`.
        const runId = normalizedArgs.runId || 'all';
        return `[${runId}]`;
      }

      case 'send_message': {
        const target = normalizedArgs.target || 'unknown';
        const message = normalizedArgs.message || '';
        const preview = message.length > 40 ? `${message.slice(0, 40)}...` : message;
        return `[${target}] "${preview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'cancel_run': {
        const target = normalizedArgs.target || 'unknown';
        return `[${target}]`;
      }

      case 'get_shell_job': {
        const jobId = normalizedArgs.job_id || 'unknown';
        return `[${jobId}]`;
      }

      case 'cancel_shell_job': {
        const jobId = normalizedArgs.job_id || 'unknown';
        return `[${jobId}]`;
      }

      case 'monitor_shell_job': {
        const jobId = normalizedArgs.job_id || 'unknown';
        const pattern = normalizedArgs.pattern ? ` for "${normalizedArgs.pattern}"` : '';
        return `[${jobId}]${pattern}`;
      }

      case 'cancel_shell_monitor': {
        const watchId = normalizedArgs.watch_id || 'unknown';
        return `[${watchId}]`;
      }

      case 'ask_orchestrator': {
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'activate_skill': {
        const name = normalizedArgs.name || 'unknown';
        return `[${name}]`;
      }

      case 'run_code': {
        // The `code` arg is a whole program; the default branch would dump it into
        // the header. The model-written description is the only one-line summary.
        const description = normalizedArgs.description;
        return typeof description === 'string' ? description.replace(/\r?\n/g, ' ').trim() : '';
      }

      case 'run_agent_workflow':
        // The only arg is a whole JavaScript program; no slice of it reads usefully in a
        // one-line header, so the verb alone carries the entry.
        return '';

      case 'web_search': {
        const query = normalizedArgs.query || '';
        return `for "${query}"`;
      }

      case 'web_fetch': {
        const url = normalizedArgs.url || '';
        return `"${url}"`;
      }

      case 'ask_mentor': {
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'ask_user': {
        const questions = normalizedArgs.questions;
        if (Array.isArray(questions) && questions.length > 0) {
          const qList = questions.map((q: any) => q?.question).filter(Boolean);
          if (qList.length === 1) {
            const question = qList[0];
            const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
            return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
          } else if (qList.length > 1) {
            const joined = qList.join(', ');
            const qPreview = joined.length > 40 ? `${joined.slice(0, 40)}...` : joined;
            return `["${qPreview.replace(/\r?\n/g, ' ')}"]`;
          }
        }
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'read_code_outline': {
        const path = normalizedArgs.path || 'unknown';
        return `of "${path}"`;
      }

      case 'code_context_search': {
        const queryType = normalizedArgs.query_type;
        if (queryType === 'symbol') {
          return `for symbol "${normalizedArgs.symbol || ''}"`;
        }
        return `for files related to "${normalizedArgs.path || ''}"`;
      }

      case TOOL_NAME_APPLY_PATCH: {
        const type = normalizedArgs.type || 'unknown';
        const path = normalizedArgs.path || 'unknown';
        return `${type} ${path}`;
      }

      case TOOL_NAME_SEARCH_REPLACE: {
        const path = normalizedArgs.path || 'unknown';
        if (displayMode === 'concise') {
          if (normalizedArgs.replacements) {
            const replacements = normalizedArgs.replacements || [];
            const countText = replacements.length > 1 ? ` (+ ${replacements.length - 1} more)` : '';
            return `"${path}"${countText}`;
          } else {
            return `"${path}"`;
          }
        }
        if (normalizedArgs.replacements) {
          const replacements = normalizedArgs.replacements || [];
          const firstRep = replacements[0] || {};
          const searchContent = firstRep.search_content || '';
          const replaceContent = firstRep.replace_content || '';
          const search = searchContent.length > 30 ? `${searchContent.slice(0, 30)}...` : searchContent;
          const replace = replaceContent.length > 30 ? `${replaceContent.slice(0, 30)}...` : replaceContent;
          const countText = replacements.length > 1 ? ` (+ ${replacements.length - 1} more)` : '';
          return `"${search}" → "${replace}" "${path}"${countText}`;
        } else {
          const searchContent = normalizedArgs.search_content || '';
          const replaceContent = normalizedArgs.replace_content || '';
          const search = searchContent.length > 30 ? `${searchContent.slice(0, 30)}...` : searchContent;
          const replace = replaceContent.length > 30 ? `${replaceContent.slice(0, 30)}...` : replaceContent;
          return `"${search}" → "${replace}" "${path}"`;
        }
      }

      case TOOL_NAME_CREATE_FILE: {
        const filePath = normalizedArgs.path || 'unknown';
        return `"${filePath}"`;
      }

      case 'memory_list': {
        const limit = normalizedArgs.limit ? ` (limit: ${normalizedArgs.limit})` : '';
        return `(global + project)${limit}`;
      }
      case 'memory_get':
      case 'memory_search':
        return `for "${normalizedArgs.query ?? normalizedArgs.id ?? ''}"`;
      case 'memory_create': {
        const id = normalizedArgs.id ?? '';
        const title = normalizedArgs.title ?? '';
        return `"${id}" - "${title}" (${normalizedArgs.scope ?? ''})`;
      }
      case 'memory_update':
        return `"${normalizedArgs.id ?? ''}" (${normalizedArgs.scope ?? ''})`;
      case 'memory_delete':
        return `"${normalizedArgs.id ?? ''}" (${normalizedArgs.scope ?? ''})`;

      default: {
        // Generic fallback for unknown tools
        const entries = Object.entries(normalizedArgs);
        if (entries.length === 0) return '';

        return entries
          .map(([key, value]) => {
            const stringValue =
              typeof value === 'string'
                ? value.length > 50
                  ? `${value.slice(0, 50)}...`
                  : value
                : JSON.stringify(value);
            return `${key}=${stringValue}`;
          })
          .join(' ');
      }
    }
  } catch {
    return '';
  }
};
