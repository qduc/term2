const MAX_IMAGE_DATA_LEN = 100;
const MAX_SYSTEM_PROMPT_LEN = 20;
const MAX_TOOL_DESC_LEN = 20;
const MAX_TOOL_CALL_LEN = 20;
const MAX_TOOL_OUTPUT_LEN = 20;
const MAX_LOG_TEXT_LEN = 100;

/**
 * Truncates verbose data in log metadata to prevent log overflow.
 * Targets: base64 images in messages, system/developer prompt content, tool descriptions,
 * tool call arguments, and tool output.
 */
export function sanitizeLogMetadata(meta: Record<string, any>): Record<string, any> {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  let result = meta;

  // Truncate image data, system messages, tool calls, and tool output in messages
  if (Array.isArray(result.messages)) {
    let messagesModified = false;

    const messages = result.messages.map((msg: any) => {
      if (!msg || typeof msg !== 'object') {
        return msg;
      }

      let newMsg: Record<string, any> | null = null;

      // Truncate base64 images in content array items
      if (Array.isArray(msg.content)) {
        const newContent = msg.content.map((item: any) => {
          if (!item || typeof item !== 'object') {
            return item;
          }

          let itemModified = false;
          const newItem = { ...item };

          if (typeof newItem.image === 'string' && newItem.image.startsWith('data:image/')) {
            newItem.image = truncateBase64(newItem.image);
            itemModified = true;
          }

          if (newItem.image_url && typeof newItem.image_url === 'object' && !Array.isArray(newItem.image_url)) {
            const imageUrl = newItem.image_url;
            if (typeof imageUrl.url === 'string' && imageUrl.url.startsWith('data:image/')) {
              newItem.image_url = {
                ...imageUrl,
                url: truncateBase64(imageUrl.url),
              };
              itemModified = true;
            }
          }

          return itemModified ? newItem : item;
        });

        const contentModified = newContent.some((item: any, index: number) => item !== msg.content[index]);
        if (contentModified) {
          newMsg = { ...msg, content: newContent };
        }
      }

      // Truncate system/developer message string content
      if (
        (msg.role === 'system' || msg.role === 'developer') &&
        typeof msg.content === 'string' &&
        msg.content.length > MAX_SYSTEM_PROMPT_LEN
      ) {
        const truncated = truncateString(msg.content, MAX_SYSTEM_PROMPT_LEN);
        const base = newMsg ?? { ...msg };
        newMsg = { ...base, content: truncated };
      }

      // Truncate assistant tool call arguments
      if (Array.isArray(msg.tool_calls)) {
        const toolCalls = msg.tool_calls.map((toolCall: any) => {
          if (!toolCall || typeof toolCall !== 'object') {
            return toolCall;
          }

          const fn = toolCall.function;
          if (!fn || typeof fn !== 'object') {
            return toolCall;
          }

          let fnModified = false;
          const newFn = { ...fn };

          if (typeof newFn.arguments === 'string' && newFn.arguments.length > MAX_TOOL_CALL_LEN) {
            newFn.arguments = truncateString(newFn.arguments, MAX_TOOL_CALL_LEN);
            fnModified = true;
          }

          return fnModified ? { ...toolCall, function: newFn } : toolCall;
        });

        const toolCallsModified = toolCalls.some((toolCall: any, index: number) => toolCall !== msg.tool_calls[index]);
        if (toolCallsModified) {
          const base = newMsg ?? { ...msg };
          newMsg = { ...base, tool_calls: toolCalls };
        }
      }

      // Truncate tool output
      if (msg.role === 'tool') {
        const base = newMsg ?? { ...msg };
        let toolMsgModified = false;
        const updatedToolMsg = { ...base };

        if (typeof updatedToolMsg.content === 'string' && updatedToolMsg.content.length > MAX_TOOL_OUTPUT_LEN) {
          updatedToolMsg.content = truncateString(updatedToolMsg.content, MAX_TOOL_OUTPUT_LEN);
          toolMsgModified = true;
        }

        for (const key of ['output', 'result', 'data']) {
          if (typeof updatedToolMsg[key] === 'string' && updatedToolMsg[key].length > MAX_TOOL_OUTPUT_LEN) {
            updatedToolMsg[key] = truncateString(updatedToolMsg[key], MAX_TOOL_OUTPUT_LEN);
            toolMsgModified = true;
          }
        }

        if (toolMsgModified) {
          newMsg = updatedToolMsg;
        }
      }

      return newMsg ?? msg;
    });

    messagesModified = messages.some((msg: any, index: number) => msg !== result.messages[index]);
    if (messagesModified) {
      result = { ...result, messages };
    }
  }

  // Truncate tool descriptions
  if (Array.isArray(result.tools)) {
    const tools = result.tools.map((tool: any) => {
      if (!tool || typeof tool !== 'object') return tool;

      const fn = tool.function;
      if (!fn || typeof fn !== 'object') return tool;

      let fnModified = false;
      const newFn = { ...fn };

      if (typeof newFn.description === 'string' && newFn.description.length > MAX_TOOL_DESC_LEN) {
        newFn.description = truncateString(newFn.description, MAX_TOOL_DESC_LEN);
        fnModified = true;
      }

      return fnModified ? { ...tool, function: newFn } : tool;
    });

    const toolsModified = tools.some((t: any, i: number) => t !== result.tools[i]);
    if (toolsModified) {
      result = { ...result, tools };
    }
  }

  return result;
}

export function truncateImageData(meta: Record<string, any>): Record<string, any> {
  return sanitizeLogMetadata(meta);
}

export function truncateLogText(text: string, maxLen = MAX_LOG_TEXT_LEN): string {
  if (maxLen < 0) return text;
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length <= maxLen) {
    return normalized;
  }

  const headLen = Math.floor(maxLen / 2);
  const tailLen = maxLen - headLen;
  const omitted = normalized.length - headLen - tailLen;

  return `${normalized.slice(0, headLen)}... (truncated, ${omitted} chars omitted) ...${normalized.slice(-tailLen)}`;
}

function truncateBase64(data: string): string {
  if (data.length <= MAX_IMAGE_DATA_LEN) {
    return data;
  }
  return `${data.slice(0, MAX_IMAGE_DATA_LEN)}... (truncated)`;
}

function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}... (truncated, ${str.length - maxLen} chars omitted)`;
}
