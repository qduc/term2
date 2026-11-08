import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireContent } from '../../protocol/wire.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

export type PromptInput = { readonly text: string; readonly attachments: readonly WireContent[] };

/** Preserve v1 embedded binary resources without fetching their URI or treating it as a file path. */
export function v1Prompt(blocks: readonly ContentBlock[]): acp.PromptRequest['prompt'] {
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type !== 'resource' || !('blob' in block.resource)) return [block];
    const { blob, mimeType, uri } = block.resource;
    if (Buffer.from(blob, 'base64').toString('base64') !== blob)
      throw acp.RequestError.invalidParams(undefined, 'Embedded blobs require padded RFC4648 base64');
    if (mimeType?.startsWith('image/'))
      return [
        { type: 'text', text: `[Embedded image: ${uri}]` },
        { type: 'image', data: blob, mimeType },
      ];
    return [
      {
        type: 'text',
        text: `[Embedded resource: ${uri}; MIME: ${mimeType ?? 'application/octet-stream'}; encoding: base64]\n${blob}`,
      },
    ];
  });
}

/** Convert ACP blocks without fetching resources or reinterpreting image data as paths/URLs. */
export function promptInput(blocks: acp.PromptRequest['prompt']): PromptInput {
  const content: WireContent[] = [];
  for (const block of blocks) {
    if (block.type === 'image') {
      const data = block.data;
      const mediaType = block.mimeType;
      if (
        typeof data !== 'string' ||
        typeof mediaType !== 'string' ||
        !/^image\/[a-zA-Z0-9.+-]+$/.test(mediaType) ||
        !data ||
        Buffer.from(data, 'base64').toString('base64') !== data
      ) {
        throw acp.RequestError.invalidParams(undefined, 'Images require image/* MIME and raw padded RFC4648 base64');
      }
      content.push({ type: 'image', data, mediaType });
      continue;
    }
    let text: string;
    if (block.type === 'text' && typeof block.text === 'string') text = block.text;
    else if (block.type === 'resource_link') text = `[Resource: ${String(block.uri)}]`;
    else if (block.type === 'resource') {
      const resource = block.resource;
      if (!resource || typeof resource !== 'object' || !('text' in resource) || typeof resource.text !== 'string') {
        throw acp.RequestError.invalidParams(undefined, 'Unsupported embedded resource');
      }
      text = resource.text;
    } else throw acp.RequestError.invalidParams(undefined, `Unsupported prompt content block: ${block.type}`);
    const previous = content.at(-1);
    if (previous?.type === 'text') content[content.length - 1] = { type: 'text', text: `${previous.text}\n${text}` };
    else content.push({ type: 'text', text });
  }
  if (!content.some((part) => part.type === 'image' || part.text.trim())) {
    throw acp.RequestError.invalidParams(undefined, 'prompt must contain text or an image');
  }
  // Wire submit prepends its text field to attachments. Keep the rest of the
  // block sequence intact, including text after images and image-only prompts.
  const [first, ...rest] = content;
  return first.type === 'text' ? { text: first.text, attachments: rest } : { text: '', attachments: content };
}
