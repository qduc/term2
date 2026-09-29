import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOST = '127.0.0.1';

function parseHost(value) {
  const host = value.trim();
  if (!host || /[\\/@?#]/u.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname === '*' || hostname === '0.0.0.0' || hostname === '[::]') return null;
    return hostname;
  } catch {
    return null;
  }
}

export function optedInHostnames(value = process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS) {
  if (!value) return [];
  return value
    .split(',')
    .map(parseHost)
    .filter((hostname) => hostname !== null);
}

export function chooseListenHost(value = process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS) {
  const hostname = optedInHostnames(value)[0];
  if (!hostname) return LOOPBACK_HOST;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${chooseListenHost()}\n`);
}
