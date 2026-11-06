import fs from 'node:fs';
import path from 'node:path';

const MAX_IMAGES = 10;
const MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_MS = 30_000;
const extensions = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

function imageExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'webp';
  return undefined;
}

/**
 * Stage fresh Discord attachments as private local images for the existing read_file tool.
 * Only the authenticated ingress caller decides whose media to fetch. Never return source URLs,
 * names or network errors; omitted media is counted, not silently treated as viewed.
 * Files live with bridge state (no automatic eviction); normal session read approvals still apply.
 */
export async function stageDiscordImages(
  attachments: readonly unknown[],
  options: { stateDir: string; channelId: string; fetch?: typeof fetch },
): Promise<{ paths: string[]; omitted: number }> {
  const paths: string[] = [];
  const signal = AbortSignal.timeout(DOWNLOAD_MS);
  let remaining = MAX_BYTES;
  let directory: string | undefined;
  for (const [index, value] of attachments.slice(0, MAX_IMAGES).entries()) {
    try {
      if (!value || typeof value !== 'object') continue;
      const attachment = value as Record<string, unknown>;
      if (
        typeof attachment.id !== 'string' ||
        !/^[0-9]{1,24}$/.test(attachment.id) ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size <= 0 ||
        attachment.size > remaining ||
        typeof attachment.url !== 'string' ||
        (attachment.content_type !== undefined &&
          (typeof attachment.content_type !== 'string' || !extensions.has(attachment.content_type)))
      )
        continue;
      const url = new URL(attachment.url);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'cdn.discordapp.com' ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        !url.pathname.startsWith(`/attachments/${options.channelId}/${attachment.id}/`) ||
        url.pathname.split('/').length !== 5 ||
        !url.pathname.split('/')[4]
      )
        continue;
      // Signed CDN URLs are bearer capabilities. Never send the bot Authorization header,
      // follow a redirect, persist the URL, or let a provider fetch it on our behalf.
      const response = await (options.fetch ?? fetch)(url.href, { redirect: 'error', signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        continue;
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          remaining -= chunk.value.byteLength;
          if (remaining < 0 || size > attachment.size) throw new Error('Image byte limit');
          chunks.push(Buffer.from(chunk.value));
        }
      } finally {
        await reader.cancel();
      }
      if (size !== attachment.size) continue;
      const bytes = Buffer.concat(chunks);
      const extension = imageExtension(bytes);
      if (!extension || (attachment.content_type && extensions.get(attachment.content_type as string) !== extension))
        continue;
      directory ??= fs.mkdtempSync(path.join(options.stateDir, 'images-'));
      fs.chmodSync(directory, 0o700);
      const file = path.join(directory, `${index}.${extension}`);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      paths.push(file);
    } catch {
      // Per-attachment failures preserve successful siblings. Never log exception text:
      // fetch errors can contain signed URLs and filesystem errors can contain names.
    }
  }
  return { paths, omitted: attachments.length - paths.length };
}
