#!/usr/bin/env node
// Enforce the rewrite layer graph across imports adopted from source/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rewriteRoot = path.join(repo, 'rewrite');
const rewriteSrc = path.join(repo, 'rewrite/src');
const sourceRoot = path.join(repo, 'source');
const allowlistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-edge-allowlist.json');

// The direct path outside adopted/ that may import source/. Its closure is walked
// like an adopted file's. Which modules actually load is checked by the M1 bench,
// because IMPORT below also matches type imports and import().
const DIRECT_SOURCE_IMPORTERS = new Set(['app/agent-surface.ts', 'app/cli.ts', 'app/run.ts', 'model/provider.ts']);

const LAYER_DEPENDENCIES = {
  config: [],
  model: [],
  tools: ['model', 'config'],
  engine: ['model', 'tools', 'config'],
  session: ['engine', 'model', 'tools', 'config'],
  protocol: ['session', 'engine', 'model', 'tools', 'config'],
  host: ['protocol', 'session', 'config'],
  clients: ['host', 'protocol'],
  app: ['clients', 'host', 'protocol', 'session', 'engine', 'tools', 'model', 'config'],
};

const SOURCE_LAYERS = [
  ['session', 'services/command-message-streaming.ts'],
  ['session', 'services/generation-guard.ts'],
  ['session', 'services/input-surge-approval.ts'],
  ['session', 'services/large-uncached-input-guard.ts'],
  ['session', 'services/stream-event-processor.ts'],
  ['app', 'agent.ts'],
  ['app', 'lib/agent-factory.ts'],
  ['app', 'lib/agent-configuration.ts'],
  ['engine', 'lib/subagent-bridge.ts'],
  ['engine', 'lib/agent-chat-service.ts'],
  ['session', 'lib/tool-interceptor-registry.ts'],
  ['engine', 'services/agent-stream.ts'],
  ['engine', 'services/completion-verification/verifier.ts'],
  ...['contracts', 'gate', 'goal-stop-policy', 'orchestrator', 'root-boundary', 'store', 'workspace'].map((name) => ['engine', `services/completion-verification/${name}.ts`]),
  ['engine', 'services/decision-shadow/decision-client.ts'],
  ['engine', 'services/decision-shadow/decision-shadow-observer.ts'],
  ['engine', 'services/decision-shadow/failure-observation.ts'],
  ['engine', 'services/decision-shadow/failure-triage.ts'],
  ['engine', 'services/decision-shadow/decision-shadow-pilot.ts'],
  ['session', 'core/session-runtime.ts'],
  ['session', 'services/conversation-agent-client.ts'],
  ['session', 'services/tool-execution-ledger.ts'],
  ['session', 'services/input-surge-guard.ts'],
  ['session', 'services/provider-continuity.ts'],
  ['session', 'services/mode-notices.ts'],
  ['session', 'services/stream-snapshot.ts'],
  ['session', 'services/interruption-info.ts'],
  ['session', 'services/tool-call-arguments.ts'],
  ['session', 'services/openai-root-checkpoint-lifecycle-observer.ts'],
  ['tools', 'services/assembly/feature-selection.ts'],
  ['tools', 'services/background-task-activity.ts'],
  ['tools', 'services/execution-context.ts'],
  ['tools', 'services/ssh-service.ts'],
  ['config', 'services/tool-toggles.ts'],
  ['shared', 'services/cost/model-cost.ts'],
  ['model', 'services/cost/pricing-overlay.ts'],
  ['model', 'services/cost/pricing.ts'],
  ['model', 'services/cost/subscription-providers.ts'],
  ['config', 'services/settings/'],
  ['config', 'services/profiles/'],
  ['model', 'services/model-service.ts'],
  ['shared', 'services/service-interfaces.ts'],
  ['model', 'providers/'],
  ['model', 'services/models/'],
  ['shared', 'tools/agent/ask-user-constants.ts'],
  ['tools', 'tools/'],
  ...['shell', 'mcp', 'sandboxed-code-host', 'memory', 'skills', 'workspace', 'subagents'].map((name) => ['tools', `services/${name}/`]),
  ['engine', 'services/agent-runtime/'],
  ['engine', 'services/retry/'],
  ['engine', 'lib/agent-client.ts'],
  ...['conversation', 'session', 'logging', 'queue', 'hooks', 'approval'].map((name) => ['session', `services/${name}/`]),
  ['session', 'prompts/'],
  ['shared', 'gateway/interaction-protocol.ts'],
  ['host', 'gateway/'],
  ...['components/', 'hooks/', 'commands/', 'skins/', 'theme/', 'acp-v2/'].map((name) => ['clients', name]),
  ['clients', 'app.tsx'],
  ['clients', 'non-interactive.ts'],
  ['clients', 'services/control-socket/'],
  ['clients', 'services/discord/'],
  ['shared', 'utils/'],
  ['shared', 'types/'],
  ['shared', 'contracts/'],
  ['shared', 'lib/'],
];

// Imports are collected from static ES module syntax, including re-exports and dynamic imports.
const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function* files(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

function resolveImport(importer, specifier) {
  const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
  if (!isRelative && !(specifier === 'source' || specifier.startsWith('source/') || specifier === 'rewrite' || specifier.startsWith('rewrite/'))) return null;
  const unresolved = isRelative ? path.resolve(path.dirname(importer), specifier) : path.join(repo, specifier);
  const candidates = [unresolved];
  if (/\.m?js$/.test(unresolved)) candidates.push(unresolved.replace(/\.m?js$/, '.ts'), unresolved.replace(/\.m?js$/, '.tsx'));
  if (/\.jsx$/.test(unresolved)) candidates.push(unresolved.replace(/\.jsx$/, '.tsx'));
  if (!path.extname(unresolved)) candidates.push(...['.ts', '.tsx', '.js', '.jsx', '.json'].map((ext) => unresolved + ext));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const index = path.join(candidate, `index${ext}`);
      if (fs.existsSync(index)) return index;
    }
  }
  return null;
}

function sourceRelative(file) {
  return path.relative(sourceRoot, file).split(path.sep).join('/');
}

function sourceLayer(file) {
  const relative = sourceRelative(file);
  return SOURCE_LAYERS.find(([, prefix]) =>
    prefix.endsWith('/') ? relative.startsWith(prefix) : relative === prefix,
  )?.[0] ?? null;
}

function sourceEdge(importer, target, fromLayer, toLayer) {
  return `${sourceRelative(importer)} -> ${sourceRelative(target)} (${fromLayer} -> ${toLayer})`;
}

function rewriteLayer(file) {
  return path.relative(rewriteSrc, file).split(path.sep)[0];
}

function imports(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)].map((match) => ({ specifier: match[1], target: resolveImport(file, match[1]) }));
}

const problems = new Set();
const legacyEdges = new Set();
const actualEdges = new Set();
const reachedUnknown = new Set();
const sourceFiles = [...files(sourceRoot)];

// Preserve the direct rewrite-to-rewrite layer guard as adopted adapters are added.
for (const importer of files(rewriteSrc)) {
  const fromLayer = rewriteLayer(importer);
  for (const { target } of imports(importer)) {
    if (!target || !target.startsWith(rewriteSrc + path.sep)) continue;
    const toLayer = rewriteLayer(target);
    if (fromLayer !== toLayer && !LAYER_DEPENDENCIES[fromLayer]?.includes(toLayer)) {
      problems.add(`${path.relative(rewriteSrc, importer)}: ${fromLayer}/ may not import ${toLayer}/`);
    }
  }
}

// Catalog pre-existing source-to-source edges that cross the declared layer graph.
for (const importer of sourceFiles) {
  const fromLayer = sourceLayer(importer);
  for (const { target } of imports(importer)) {
    if (!target || !target.startsWith(sourceRoot + path.sep)) continue;
    const toLayer = sourceLayer(target);
    if (!fromLayer || !toLayer) continue;
    actualEdges.add(sourceEdge(importer, target, fromLayer, toLayer));
    if (fromLayer !== 'shared' && toLayer !== 'shared' && fromLayer !== toLayer && !LAYER_DEPENDENCIES[fromLayer]?.includes(toLayer)) {
      legacyEdges.add(sourceEdge(importer, target, fromLayer, toLayer));
    }
  }
}

let allowedLegacyEdges;
try {
  allowedLegacyEdges = new Set(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')));
} catch (error) {
  console.error(`cannot read ${path.relative(repo, allowlistPath)}: ${error.message}`);
  process.exit(1);
}
for (const edge of legacyEdges) if (!allowedLegacyEdges.has(edge)) problems.add(`new source dependency edge: ${edge}`);
for (const edge of allowedLegacyEdges) if (!actualEdges.has(edge)) console.log(`stale allowlist entry: ${edge}`);

// source/ must not reach back into rewrite/, including indirect imports.
for (const importer of sourceFiles) {
  for (const { target } of imports(importer)) {
    if (target && target.startsWith(rewriteRoot + path.sep)) problems.add(`source/${sourceRelative(importer)} imports rewrite/${path.relative(rewriteRoot, target).split(path.sep).join('/')}`);
  }
}

// An adopted file may import source/ directly. Follow every source edge reachable from it.
for (const entry of files(rewriteSrc)) {
  const relative = path.relative(rewriteSrc, entry).split(path.sep).join('/');
  const adoptedLayer = relative.match(/^([^/]+)\/adopted\//)?.[1] ?? (DIRECT_SOURCE_IMPORTERS.has(relative) ? relative.split('/')[0] : null);
  const visited = new Set();
  const queue = [];
  for (const { target } of imports(entry)) {
    if (!target || !target.startsWith(sourceRoot + path.sep)) continue;
    if (!adoptedLayer) problems.add(`${path.relative(repo, entry)} imports source/${sourceRelative(target)} outside adopted/`);
    else {
      const layer = sourceLayer(target);
      if (!layer) reachedUnknown.add(sourceRelative(target));
      const allowed = layer === 'shared' || layer === adoptedLayer || LAYER_DEPENDENCIES[adoptedLayer]?.includes(layer);
      if (layer && !allowed) {
        problems.add(`${path.relative(repo, entry)} (${adoptedLayer}/) directly imports source/${sourceRelative(target)} (${layer}/)`);
      }
      if (!layer || allowed) queue.push({ file: target, context: layer && layer !== 'shared' ? layer : adoptedLayer });
    }
  }
  if (!adoptedLayer) continue;
  while (queue.length) {
    const state = queue.shift();
    const current = state.file;
    const context = state.context;
    const stateKey = `${current}\0${context}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);
    const layer = sourceLayer(current);
    if (!layer) {
      reachedUnknown.add(sourceRelative(current));
    }
    for (const { target } of imports(current)) {
      if (target && target.startsWith(sourceRoot + path.sep)) {
        const targetLayer = sourceLayer(target);
        const fromLayer = sourceLayer(current);
        // Shared and unmapped files retain the caller's restrictions; a mapped
        // layer takes responsibility for its own outgoing edges.
        const effectiveLayer = fromLayer && fromLayer !== 'shared' ? fromLayer : context;
        if (targetLayer && targetLayer !== 'shared' && targetLayer !== effectiveLayer && !LAYER_DEPENDENCIES[effectiveLayer]?.includes(targetLayer)) {
          const edge = fromLayer ? sourceEdge(current, target, fromLayer, targetLayer) : null;
          if (!edge || !allowedLegacyEdges.has(edge)) {
            problems.add(`${path.relative(repo, entry)} (${adoptedLayer}/) reaches source/${sourceRelative(target)} (${targetLayer}/) through ${edge ?? `unmapped source/${sourceRelative(current)}`} [context ${effectiveLayer}]`);
            continue;
          }
        }
        queue.push({ file: target, context: targetLayer && targetLayer !== 'shared' ? targetLayer : effectiveLayer });
      }
      if (target && target.startsWith(rewriteRoot + path.sep)) problems.add(`source/${sourceRelative(current)} imports rewrite/${path.relative(rewriteRoot, target).split(path.sep).join('/')}`);
    }
  }
}

if (reachedUnknown.size) {
  console.log('reached source files missing from the layer map:');
  for (const file of [...reachedUnknown].sort()) console.log(`  source/${file}`);
}
if (problems.size) {
  console.error([...problems].sort().join('\n'));
  process.exit(1);
}
console.log(`layer check passed (${allowedLegacyEdges.size} allowlisted source edges)`);
