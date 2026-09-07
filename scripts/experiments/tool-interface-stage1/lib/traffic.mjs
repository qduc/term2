import fs from 'node:fs';
import path from 'node:path';
import { headerSnapshotFromDescription, HEADER_MARK } from './header.mjs';

export function isNamesOnlyTools(tools) {
  return Array.isArray(tools) && tools.length > 0 && tools.every((item) => typeof item === 'string');
}

function toolName(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.name === 'string') return entry.name;
  if (entry.function && typeof entry.function.name === 'string') return entry.function.name;
  return null;
}

function toolDescription(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.description === 'string') return entry.description;
  if (entry.function && typeof entry.function.description === 'string') return entry.function.description;
  return null;
}

export function collectToolEntries(body) {
  const entries = [];
  if (!body || typeof body !== 'object') return entries;
  if (Array.isArray(body.tools)) entries.push(...body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item && typeof item === 'object' && Array.isArray(item.tools)) entries.push(...item.tools);
    }
  }
  return entries;
}

export function extractRunCodeDescriptionFromRawBody(body) {
  const entries = collectToolEntries(body);
  for (const entry of entries) {
    if (toolName(entry) === 'run_code') {
      const description = toolDescription(entry);
      if (typeof description === 'string' && description.includes(HEADER_MARK)) return description;
      if (typeof description === 'string') return description;
    }
  }
  return null;
}

export function listRawSidecars(trafficRoot) {
  if (!trafficRoot || !fs.existsSync(trafficRoot)) return [];
  const found = [];
  const stack = [trafficRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('_raw.json')) found.push(full);
    }
  }
  return found.sort();
}

export function snapshotFromRawSidecars(trafficRoot) {
  const files = listRawSidecars(trafficRoot);
  if (files.length === 0) {
    return { ok: false, reason: 'missing-raw-sidecars', combinedHeaderBytes: null, toolNames: [] };
  }
  let description = null;
  let sourceFile = null;
  let namesOnlySanitized = false;
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const body = parsed.body ?? parsed.sent?.body ?? parsed;
    const extracted = extractRunCodeDescriptionFromRawBody(body);
    if (extracted) {
      description = extracted;
      sourceFile = file;
      break;
    }
    if (isNamesOnlyTools(collectToolEntries(body))) namesOnlySanitized = true;
  }
  if (!description) {
    return {
      ok: false,
      reason: namesOnlySanitized ? 'names-only-tools-not-raw' : 'run-code-description-missing',
      combinedHeaderBytes: null,
      toolNames: [],
      sidecarCount: files.length,
    };
  }
  const snapshot = headerSnapshotFromDescription(description, {
    source: 'provider-traffic-raw',
    sourceFile: path.basename(sourceFile),
  });
  const nonempty = snapshot.headerFound && snapshot.combinedHeaderBytes > 0 && snapshot.toolNameCount > 0;
  return { ok: nonempty, reason: nonempty ? null : 'empty-header', sidecarCount: files.length, ...snapshot };
}
