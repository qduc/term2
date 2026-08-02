import type {
  StreamedModelMessagePart,
  StreamedModelProviderOptions,
  StreamedModelToolResultPart,
  StreamedModelTurnInput,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';

/**
 * The Codex Responses adapter's application-to-wire conversion. Keep this
 * switch exhaustive: a new application input variant must be represented here
 * or rejected before it can become malformed Responses input.
 */
export function toCodexResponsesInput(input: readonly StreamedModelTurnInput[]): unknown[] {
  return input.map(toCodexResponsesItem);
}

export function toCodexResponsesItem(item: StreamedModelTurnInput): unknown {
  switch (item.type) {
    case 'message':
      return {
        type: 'message',
        role: item.role,
        content: item.content.map((part) => toCodexMessagePart(item.role, part)),
      };
    case 'reasoning': {
      const metadata = codexNativeMetadata(item.providerMetadata);
      return {
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        ...metadata,
        ...(item.text ? { content: [{ type: 'reasoning_text', text: item.text }] } : {}),
      };
    }
    case 'tool_call':
      return {
        type: 'function_call',
        call_id: requireNonEmptyString(item.id, 'tool call id'),
        name: requireNonEmptyString(item.name, 'tool call name'),
        arguments: item.arguments,
      };
    case 'tool_result':
      return {
        type: 'function_call_output',
        call_id: requireNonEmptyString(item.id, 'tool result id'),
        output: toCodexToolResultOutput(item.output),
      };
    default:
      return assertNever(item, 'StreamedModelTurnInput');
  }
}

/** Converts every supported message part without coercing objects to strings. */
export function toCodexMessagePart(role: 'system' | 'user' | 'assistant', part: StreamedModelMessagePart): unknown {
  // input_text/output_text appear only in legacy callers; normalize them
  // explicitly instead of treating their object value as an image.
  const rawPart = part as
    | StreamedModelMessagePart
    | { readonly type: 'input_text' | 'output_text'; readonly text: string };
  if (rawPart.type === 'text' || rawPart.type === 'input_text' || rawPart.type === 'output_text') {
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: rawPart.text };
  }
  if (role === 'system' || role === 'assistant') {
    throw new Error(`Unsupported Codex ${role} message content: image parts are not supported.`);
  }
  const imagePart = part as Extract<StreamedModelMessagePart, { readonly type: 'image' }>;
  return {
    type: 'input_image',
    ...toCodexImageReference(imagePart.image, 'message image'),
    ...(imagePart.detail ? { detail: imagePart.detail } : {}),
  };
}

export function toCodexToolResultOutput(output: string | readonly StreamedModelToolResultPart[]): unknown {
  if (typeof output === 'string') return output;
  return output.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'input_text', text: part.text };
      case 'image':
        return {
          type: 'input_image',
          ...toCodexToolResultImage(part.image, 'tool result image'),
          ...(part.detail ? { detail: part.detail } : {}),
        };
      case 'file':
        return { type: 'input_file', ...toCodexFileReference(part.file) };
      default:
        return assertNever(part, 'StreamedModelToolResultPart');
    }
  });
}

/** Maps every request setting to the legacy-model settings envelope. */
export function toCodexModelSettings(request: StreamedModelTurnRequest): Record<string, unknown> {
  return {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
    ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
    ...(request.providerOptions !== undefined ? { providerData: request.providerOptions } : {}),
  };
}

function toCodexImageReference(image: unknown, context: string): Record<string, unknown> {
  if (image === undefined) {
    throw new Error(`Unsupported Codex ${context}: missing image reference.`);
  }
  if (typeof image === 'string') return { image_url: image };
  if (isRecord(image) && typeof image.id === 'string') return { file_id: image.id };
  throw new Error(`Unsupported Codex ${context}: expected a URL or file id.`);
}

function toCodexToolResultImage(image: unknown, context: string): Record<string, unknown> {
  if (typeof image === 'string') return { image_url: image };
  if (!isRecord(image)) throw new Error(`Unsupported Codex ${context}: missing image reference.`);
  if (typeof image.id === 'string' || typeof image.fileId === 'string') {
    return { file_id: typeof image.fileId === 'string' ? image.fileId : image.id };
  }
  if (typeof image.url === 'string') return { image_url: image.url };
  if (typeof image.data === 'string' || image.data instanceof Uint8Array) {
    const data = typeof image.data === 'string' ? image.data : Buffer.from(image.data).toString('base64');
    const mediaType = typeof image.mediaType === 'string' ? image.mediaType : 'application/octet-stream';
    return { image_url: `data:${mediaType};base64,${data}` };
  }
  throw new Error(`Unsupported Codex ${context}: expected URL, file id, or image data.`);
}

function toCodexFileReference(file: unknown): Record<string, unknown> {
  if (typeof file === 'string') return { file_id: file };
  if (!isRecord(file)) throw new Error('Unsupported Codex tool result file: missing file reference.');
  const filename = typeof file.filename === 'string' ? { filename: file.filename } : {};
  if (typeof file.id === 'string') return { file_id: file.id, ...filename };
  if (typeof file.url === 'string') return { file_url: file.url, ...filename };
  if (typeof file.data === 'string' || file.data instanceof Uint8Array) {
    if (typeof file.filename !== 'string') {
      throw new Error('Unsupported Codex tool result file: inline data requires a filename.');
    }
    return {
      file_data: typeof file.data === 'string' ? file.data : Buffer.from(file.data).toString('base64'),
      filename: file.filename,
    };
  }
  throw new Error('Unsupported Codex tool result file: expected file id, URL, or inline data.');
}

/** Provider metadata is namespaced when emitted by this adapter, but accepts legacy direct metadata too. */
function codexNativeMetadata(metadata: StreamedModelProviderOptions | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const nested = metadata.codex;
  if (isRecord(nested)) return { ...nested };
  return { ...metadata };
}

function requireNonEmptyString(value: string, context: string): string {
  if (!value) throw new Error(`Unsupported Codex ${context}: expected a non-empty string.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never, context: string): never {
  throw new Error(`Unsupported ${context}: ${JSON.stringify(value)}`);
}
