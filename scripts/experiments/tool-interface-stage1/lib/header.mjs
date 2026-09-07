/** Split and measure the model-facing run_code description. */

export const HEADER_MARK = 'Available inside the script';

export function splitRunCodeDescription(description) {
  const text = typeof description === 'string' ? description : '';
  const index = text.indexOf(HEADER_MARK);
  if (index < 0) {
    return {
      staticProse: text,
      header: '',
      headerFound: false,
      combinedHeaderBytes: 0,
      staticProseBytes: Buffer.byteLength(text, 'utf8'),
    };
  }
  const staticProse = text.slice(0, index);
  const header = text.slice(index);
  return {
    staticProse,
    header,
    headerFound: true,
    combinedHeaderBytes: Buffer.byteLength(header, 'utf8'),
    staticProseBytes: Buffer.byteLength(staticProse, 'utf8'),
  };
}

const NAME_LINE = /^- tools\.([A-Za-z0-9_]+)(?:\(|$)/gm;

export function extractToolNamesFromHeader(header) {
  const names = [];
  const seen = new Set();
  for (const match of String(header).matchAll(NAME_LINE)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function compareNameLists(left, right) {
  const a = [...(left ?? [])];
  const b = [...(right ?? [])];
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function nameSet(names) {
  return [...new Set(names ?? [])].sort();
}

export function compareNameSets(left, right) {
  const a = nameSet(left);
  const b = nameSet(right);
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function headerSnapshotFromDescription(description, extra = {}) {
  const split = splitRunCodeDescription(description);
  return {
    ...extra,
    headerFound: split.headerFound,
    combinedHeaderBytes: split.combinedHeaderBytes,
    staticProseBytes: split.staticProseBytes,
    staticProseSha256: sha256(split.staticProse),
    headerSha256: sha256(split.header),
    toolNames: extractToolNamesFromHeader(split.header),
    toolNameCount: extractToolNamesFromHeader(split.header).length,
  };
}

export function sha256(text) {
  const { createHash } = awaitCrypto();
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function awaitCrypto() {
  return requireCrypto();
}

function requireCrypto() {
  return globalThis.__term2Crypto ?? loadCrypto();
}

function loadCrypto() {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const crypto = globalThis.crypto?.createHash
    ? globalThis.crypto
    : null;
  if (crypto) {
    globalThis.__term2Crypto = crypto;
    return crypto;
  }
  // Synchronous import is fine in Node ESM via createRequire-less path:
  // this module is only used from Node.
  return createNodeCrypto();
}

import { createHash as nodeCreateHash } from 'node:crypto';

function createNodeCrypto() {
  const api = { createHash: nodeCreateHash };
  globalThis.__term2Crypto = api;
  return api;
}
