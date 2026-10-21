import fs from 'node:fs';
import console from 'node:console';
import { URL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { decodeStoredCustomProviderConfigs } from '../../dist/services/settings/custom-provider-normalization.js';

// Only discovery is performed. Credentials remain in this process and are never
// printed or copied into candidate homes or retained evidence.
const settingsPath = path.join(os.homedir(), '.local/state/term2-nodejs/settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const provider = decodeStoredCustomProviderConfigs(settings.providers).find((p) => p.id.toLowerCase() === 'neuralwatt');
assert(provider, 'Authorized Neuralwatt provider is not configured; do not substitute.');
assert(provider.baseUrl, 'Neuralwatt has no endpoint; do not substitute.');
assert(provider.apiKey, 'Neuralwatt credentials unavailable; do not substitute.');
const url = provider.baseUrl.replace(/\/+$/, '') + '/models';
const response = await globalThis.fetch(url, {
  headers: { authorization: `Bearer ${provider.apiKey}` },
  signal: globalThis.AbortSignal.timeout(30_000),
});
const body = await response.text();
let models;
try {
  models = JSON.parse(body);
} catch {
  models = null;
}
const exact = models?.data?.filter((model) => model.id === 'deepseek-v4.1-flash') ?? [];
const receipt = {
  provider: provider.id,
  endpointOrigin: new URL(url).origin,
  status: response.status,
  exactModel: exact.map((model) => ({ id: model.id, owned_by: model.owned_by })),
  generationCalls: 0,
  checkedAt: new Date().toISOString(),
};
console.log(JSON.stringify(receipt, null, 2));
assert(response.ok && exact.length === 1, 'Authorized exact model unavailable in live catalog; do not substitute.');
