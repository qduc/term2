// The reasoning behind every repository gate, in one place, so a failure explains itself.
//
// A gate's number is a prompt for judgement, not a target. Each rule here says why it exists, what usually
// fixes it, which "fixes" only satisfy the number, and how to record a deliberate deviation. A deviation is an
// entry with a `reason` in the rule's exception file; `node scripts/gate-exceptions.mjs` lists them, and
// check-baselines shows the ones a change adds so a reviewer can judge each reason.
// Policy: docs/architecture/layers.md#when-a-gate-fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY = 'docs/architecture/layers.md#when-a-gate-fails';

// `exceptions` names where a deliberate deviation is recorded; `null` means the rule has no exception route
// and a disagreement goes to the user instead.
export const RULES = {
  'layer-direction': {
    title: 'Dependencies point down the layer table',
    why:
      'A layer can then be read, changed and tested knowing only the layers below it. An upward import ties a ' +
      'lower layer to code above it, so a change in a client can break the engine, and the cycle stops either ' +
      'side from being replaced on its own.',
    fix:
      'Move the code to the layer that owns it (`node scripts/arch-whatif.mjs .` lists the legal layers for each ' +
      'allowlisted edge), or have app/ inject the dependency as a port.',
    avoid:
      'Do not hide the dependency to get green: re-exporting it through shared/, passing the module through an ' +
      'untyped parameter, or building the import path at runtime keeps the coupling and removes the signal.',
    exceptions: {
      file: 'scripts/layer-allowlist.json',
      entry: '{ "edge": "<the edge as printed>", "reason": "..." }',
      note: 'and raise maxLayerEdges in scripts/complexity-budget.json by one',
    },
  },
  'log-readers': {
    title: 'Only session/ reads the log',
    why:
      'The live session already holds the replayed log in memory. app/ or clients/ re-parsing it is a second ' +
      'replay that can disagree with live state and costs a full read on every call.',
    fix: 'Ask the live session (store.metadata, session.acceptedHistory) or add a query to session/.',
    avoid: 'Do not copy the parsing code into app/ or clients/ under another name.',
    exceptions: null,
  },
  'one-projection': {
    title: 'Wire events are built only in protocol/',
    why:
      'Every client attached to a session reads the same events from protocol/projection.ts. A second place that ' +
      'builds them is a second translator, and clients start disagreeing about what happened.',
    fix: 'Build the event in protocol/ and have the caller emit the session update it projects from.',
    avoid: 'Do not assemble the envelope in pieces so the checker no longer recognises it.',
    exceptions: {
      file: 'scripts/rule-baseline.json',
      entry: 'wireEventOutsideProtocol: { "file": "...", "type": "...", "reason": "..." }',
    },
  },
  'names-are-jobs': {
    title: 'Names are jobs',
    why:
      '"service", "adapter" and "orchestrator" say what pattern a file is, not what it does, so nothing tells the ' +
      'next author what does not belong there. Files named that way collect unrelated code until nobody can split them.',
    fix: 'Name the file after the one job it does. If you cannot name one job, it has several: split it first.',
    avoid:
      'Do not swap in a synonym for the same non-name (manager, controller, coordinator, handler, helper). A rename ' +
      'only counts if the new name says what the file does.',
    exceptions: {
      file: 'scripts/rule-baseline.json',
      entry: 'jobNameExceptions: { "path": "<path under src/>", "reason": "..." }',
    },
  },
  'unused-exports': {
    title: 'No unused exports',
    why:
      'An export tells readers that something outside the file depends on it. A dead one makes a seam look ' +
      'load-bearing, so people preserve, test and work around code nothing uses.',
    fix: 'Delete it, or drop the `export` if the file still uses it.',
    avoid: 'Do not add a token reference elsewhere just to make it look used.',
    exceptions: {
      file: 'scripts/rule-baseline.json',
      entry: 'unusedExports: { "export": "<path under src/> <name>", "reason": "..." }',
    },
  },
  'one-fold': {
    title: 'One fold',
    why:
      'The order in which the leaf reducers combine is replay semantics. Calling a leaf reducer elsewhere creates ' +
      'a second fold that drifts from session/fold-fact.ts, and two views of the same log stop agreeing.',
    fix: 'Call foldFact from session/fold-fact.ts.',
    avoid: 'Do not re-implement a reducer locally to avoid importing it.',
    exceptions: null,
  },
  reachability: {
    title: 'Every file is reached from src/app/cli.ts',
    why:
      'Code production cannot reach is still read, typechecked and refactored, and it looks like live behaviour to ' +
      'the next reader.',
    fix: 'Delete the file, or import it from where production needs it.',
    avoid: 'Do not add an import whose only purpose is to make the file reachable.',
    exceptions: {
      file: 'scripts/reachability-allowlist.json',
      entry: '"<path>": "<reason it stays without a production importer>"',
    },
  },
  'file-size': {
    title: 'Files stay under the line limit',
    why:
      'A long file usually holds more than one job, and one job is easier to name, review and change. The limit is ' +
      'a prompt to look for the second job, not a target.',
    fix: 'If the file does two jobs, split along that seam so each part reads on its own.',
    avoid:
      'Do not split just to get under the number. Files that only make sense together (a *-policy, *-capability ' +
      'and *-registry for one idea, or a factory for one call site) cost readers more than one long file. If there ' +
      'is no second job, record a ceiling instead.',
    exceptions: {
      file: 'scripts/complexity-budget.json',
      entry: 'fileCeilings: "<path>": { "lines": N, "reason": "..." }',
      note: 'when raising an existing ceiling, rewrite its reason to cover the new lines',
    },
  },
  'root-files': {
    title: 'The repository root holds only allowlisted files',
    why:
      'The root is the first thing people and agents read. Reports, manifests and scratch output left there go ' +
      'stale and get mistaken for current project files.',
    fix: "Put task output in .handoff/ or the task's experiment folder; put tooling under scripts/.",
    avoid: 'Do not move the file to another top-level folder to dodge the check.',
    exceptions: {
      file: 'scripts/root-allowlist.json',
      entry: '{ "file": "<name>", "reason": "..." }',
    },
  },
  'duplicate-basenames': {
    title: 'File basenames are unique under src/',
    why:
      'Two files sharing a basename (like generation-guard.ts in app/, session/ and engine/) confuse readers, ' +
      'collide in imports, and invite parallel classes with the same name. Often they are fragments split to pass ' +
      'the line limit rather than real modules.',
    fix: 'Name the file after its specific job, or merge fragments that only make sense together.',
    avoid: 'Do not add meaningless prefixes or suffixes to dodge the check without clarifying what the file does.',
    exceptions: {
      file: 'scripts/rule-baseline.json',
      entry: 'duplicateBasenames: { "file": "<path under src/>", "reason": "..." }',
    },
  },
  'engine-callback-writes': {
    title: 'The engine waits instead of calling up: engine callbacks do not write the log',
    why:
      "A turn's facts reach the log through its events, appended by the turn's reader before each is accepted, " +
      'so the log order is the order the engine emitted them. A callback the engine invokes that writes the log is ' +
      'a second write path: where its facts land depends on when the engine chose to call it, and replay cannot ' +
      'tell the two apart.',
    fix:
      'Emit a TurnEvent and let session/conversation-turn.ts (and the branch reader in session/branches.ts) build ' +
      'and append the fact before accepting it, as request costs do.',
    avoid:
      'Do not move the write behind a port with another name or a value the checker cannot follow; that hides the ' +
      'write path and keeps it.',
    exceptions: {
      file: 'scripts/rule-baseline.json',
      entry:
        'engineCallbackWrites: { "callback": "TurnDeps.<member>", "reason": "why the engine must have the result ' +
        'synchronously, and why its facts still land in a deterministic place" }',
    },
  },
  'folder-fanout': {
    title: 'Folder fan-out stays under the file limit',
    why:
      'A folder with dozens of direct files usually holds multiple modules or over-split fragments. A ceiling ' +
      'prompts authors to group cohesive files into submodules or combine fragments before the folder becomes a catch-all.',
    fix: 'Group cohesive files into a subfolder with its own index.ts, or merge single-importer fragments back into their owners.',
    avoid: 'Do not create arbitrary subfolders with non-names to dodge the limit.',
    exceptions: {
      file: 'scripts/complexity-budget.json',
      entry: 'folderCeilings: "<folder>": { "files": N, "reason": "..." }',
      note: 'when raising an existing ceiling, rewrite its reason to cover the new files',
    },
  },
  baselines: {
    title: 'Recorded deviations carry reasons',
    why:
      'An exception entry is a decision to deviate from a rule. It may be added, but only with a reason a future ' +
      'agent or reviewer can judge; otherwise the exception lists grow by habit and the rules stop meaning anything.',
    fix: 'Fix the underlying violation and drop the new entry, or give the entry a reason that would convince a reviewer.',
    avoid: 'Do not write a reason that restates the rule or says only that it is needed.',
    exceptions: null,
  },
};

// A reason is read later by someone who was not there. It has to name what was weighed.
const PLACEHOLDER =
  /^(todo|tbd|temp(orary)?|needed|required|necessary|legacy|wip|later|fix later|n\/?a|none|ok|see above|same)\b/i;
export function reasonProblem(reason) {
  if (typeof reason !== 'string' || !reason.trim()) return 'has no reason';
  const text = reason.trim();
  if (text.length < 40)
    return `has a reason too short to judge ("${text}"); say what you weighed and when the entry could go`;
  if (PLACEHOLDER.test(text)) return `has a placeholder reason ("${text.slice(0, 40)}")`;
  return null;
}

// Exception entries are either legacy strings, grandfathered when the gate was introduced, or objects that carry
// a reason. Returns the set of keys and reports objects whose reason does not hold.
export function exceptionKeys(list, field, report) {
  const keys = new Set();
  for (const entry of list ?? []) {
    if (typeof entry === 'string') {
      keys.add(entry);
      continue;
    }
    const key = entry?.[field];
    if (typeof key !== 'string') {
      report(`exception entry without "${field}": ${JSON.stringify(entry)}`);
      continue;
    }
    const problem = reasonProblem(entry.reason);
    if (problem) report(`exception ${key} ${problem}`);
    else keys.add(key);
  }
  return keys;
}

// Why the legacy (string) entries in each list exist. They predate per-entry reasons.
export const LEGACY_REASONS = {
  'scripts/layer-allowlist.json': 'Crossing edges that predate the layer guard.',
  jobNameExceptions: 'Paths moved in from the old source/ tree (#87); rename each when you next touch it.',
  unusedExports: 'Exports found unused when the rule was added; still to delete or wire.',
  'scripts/root-allowlist.json': 'Standard project files present when the root check was added.',
};

// Every recorded deviation, read through `read(relativePath) -> text | null` so the same reader works on the
// working tree and on a git revision. `present` lists the exception files that exist in that tree.
export function readDeviations(read) {
  const deviations = [];
  const present = new Set();
  const json = (file) => {
    const text = read(file);
    if (text == null) return null;
    present.add(file);
    try {
      return JSON.parse(text);
    } catch {
      // An older layer allowlist was a bare list of quoted edges; keep reading it.
      const edges = [...text.matchAll(/"([^"]+ -> [^"]+ \([^)]+\))"/g)].map((m) => m[1]);
      if (edges.length) return edges;
      throw new Error(`cannot parse ${file}`);
    }
  };
  const add = (rule, file, entry, field, legacyKey, extra = {}) => {
    const legacy = typeof entry === 'string';
    deviations.push({
      rule,
      file,
      key: legacy ? entry : entry?.[field],
      reason: legacy ? null : entry?.reason ?? null,
      legacy,
      legacyReason: legacy ? LEGACY_REASONS[legacyKey] : undefined,
      ...extra,
    });
  };

  const layer = json('scripts/layer-allowlist.json');
  for (const entry of layer ?? [])
    add('layer-direction', 'scripts/layer-allowlist.json', entry, 'edge', 'scripts/layer-allowlist.json');

  const rules = json('scripts/rule-baseline.json');
  for (const entry of rules?.wireEventOutsideProtocol ?? [])
    deviations.push({
      rule: 'one-projection',
      file: 'scripts/rule-baseline.json',
      key: `${entry.file} ${entry.type}`,
      reason: entry.reason ?? null,
      legacy: false,
    });
  for (const entry of rules?.jobNameExceptions ?? [])
    add('names-are-jobs', 'scripts/rule-baseline.json', entry, 'path', 'jobNameExceptions');
  for (const entry of rules?.unusedExports ?? [])
    add('unused-exports', 'scripts/rule-baseline.json', entry, 'export', 'unusedExports');
  for (const entry of rules?.duplicateBasenames ?? [])
    add('duplicate-basenames', 'scripts/rule-baseline.json', entry, 'file', 'duplicateBasenames');
  for (const entry of rules?.engineCallbackWrites ?? [])
    add('engine-callback-writes', 'scripts/rule-baseline.json', entry, 'callback', 'engineCallbackWrites');

  const reach = json('scripts/reachability-allowlist.json');
  for (const [file, reason] of Object.entries(reach ?? {}))
    deviations.push({
      rule: 'reachability',
      file: 'scripts/reachability-allowlist.json',
      key: file,
      reason,
      legacy: false,
    });

  const budget = json('scripts/complexity-budget.json');
  for (const [file, info] of Object.entries(budget?.fileCeilings ?? {}))
    deviations.push({
      rule: 'file-size',
      file: 'scripts/complexity-budget.json',
      key: file,
      reason: info.reason ?? null,
      legacy: false,
      lines: info.lines,
    });
  for (const [folder, info] of Object.entries(budget?.folderCeilings ?? {}))
    deviations.push({
      rule: 'folder-fanout',
      file: 'scripts/complexity-budget.json',
      key: folder,
      reason: info.reason ?? null,
      legacy: false,
      files: info.files,
    });

  const root = json('scripts/root-allowlist.json');
  for (const entry of root ?? [])
    add('root-files', 'scripts/root-allowlist.json', entry, 'file', 'scripts/root-allowlist.json');

  return { deviations, present, budget };
}

export const readWorkingTree = (file) => {
  const full = path.join(repo, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
};

// Print each failing rule once with its reasoning, then exit. `failures` maps a rule id to its violation lines.
export function reportAndExit(failures, passMessage) {
  const failing = [...failures].filter(([, lines]) => lines.length);
  if (!failing.length) {
    if (passMessage) console.log(passMessage);
    return;
  }
  const out = [];
  for (const [id, lines] of failing) {
    const rule = RULES[id];
    out.push(`FAIL ${rule.title} [${id}] (${lines.length})`);
    for (const line of [...new Set(lines)].sort()) out.push(`  ${line}`);
    out.push('', `  Why this rule exists: ${rule.why}`, `  Usual fix: ${rule.fix}`, `  Not a fix: ${rule.avoid}`);
    if (rule.exceptions) {
      const { file, entry, note } = rule.exceptions;
      out.push(
        `  If you judge the rule wrong here: record ${entry} in ${file}${note ? ` (${note})` : ''}.`,
        '    The reason is read by future agents and the reviewer: say what you weighed and when the entry could go.',
        `    Precedent: node scripts/gate-exceptions.mjs ${id}`,
      );
    } else
      out.push('  This rule has no exception list. If you think it is wrong here, stop and raise it with the user.');
    out.push(`  Policy: ${POLICY}`, '');
  }
  console.error(out.join('\n'));
  process.exit(1);
}

export function failureMap() {
  const map = new Map();
  const add = (rule) => (line) => {
    if (!map.has(rule)) map.set(rule, []);
    map.get(rule).push(line);
  };
  return { map, add };
}
