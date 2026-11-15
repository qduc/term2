import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { canonicalPath, expandHome, lexicalPath } from '../../src/tools/workspace/path-identity.ts';
import { SessionAccessState } from '../../src/session/session/session-access-state.ts';
import { decideApproval, describeApproval, routeApproval } from '../../src/session/approval/approval-route.ts';

// Contract (src/tools/workspace/path-identity.ts, SessionAccessState): a session grant is
// stored and matched under one identity, so any spelling of a granted folder
// (absolute, relative, through a symlink, with `.`/`..` noise, missing tail)
// matches, while a symlink inside the folder that leads outside does not.
// Remote workspaces never consult this host's filesystem.

const fixture = (() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't2-grant-')));
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'deep', 'er'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'deep', 'file.txt'), 'x');
  fs.writeFileSync(path.join(root, 'secret', 'key'), 'x');
  fs.symlinkSync(path.join(root, 'data'), path.join(root, 'alias'));
  fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'data', 'deep', 'escape'));
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  return { root, base: path.join(root, 'ws') };
})();

const settings = { get: () => undefined, set: () => undefined };

/** Spell `rel` (relative to the fixture root, through `data` or its `alias`) in a generated way. */
const spelling = (rel) =>
  fc
    .record({
      viaAlias: fc.boolean(),
      relative: fc.boolean(),
      noise: fc.constantFrom('', './', 'er/../'),
    })
    .map(({ viaAlias, relative, noise }) => {
      const top = viaAlias ? 'alias' : 'data';
      const absolute = path.join(fixture.root, top, noise, rel);
      return relative ? path.relative(fixture.base, absolute) || '.' : absolute;
    });

const insideTarget = fc.constantFrom('deep/file.txt', 'deep/er', 'deep/missing/new.txt', 'deep');

export const approvalProperties = [
  {
    name: 'approval.grant-identity',
    property: fc.property(
      spelling('deep'),
      insideTarget.chain((rel) => spelling(rel)),
      fc.constantFrom('read', 'edit'),
      (folder, target, kind) => {
        const access = new SessionAccessState(settings);
        if (kind === 'read') access.allowReadFolder(folder, fixture.base);
        else access.allowEditFolder(folder, fixture.base);
        const allows = (t) =>
          kind === 'read' ? access.allowsRead(t, fixture.base) : access.allowsEdit(t, fixture.base);
        assert.equal(allows(target), true, `granted ${folder} did not cover ${target}`);
        assert.equal(allows(path.join(fixture.root, 'secret', 'key')), false, 'sibling outside the grant matched');
        assert.equal(
          allows(path.join(fixture.root, 'data', 'deep', 'escape', 'key')),
          false,
          'a symlink inside the grant escaped it',
        );
      },
    ),
  },
  {
    name: 'approval.remote-stays-lexical',
    property: fc.property(
      fc.array(fc.constantFrom('alias', 'data', 'deep', '..', '.', 'missing', '~', '~user'), { maxLength: 8 }),
      fc.boolean(),
      (segments, absolute) => {
        const raw = absolute ? path.join(fixture.root, ...segments) : segments.join('/') || '.';
        assert.equal(canonicalPath(raw, fixture.base, { remote: true }), lexicalPath(raw, fixture.base));
      },
    ),
  },
  {
    name: 'approval.expand-home',
    property: fc.property(
      fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/),
      fc.array(fc.stringMatching(/^[a-z0-9._-]{1,6}$/), { maxLength: 4 }),
      (user, rest) => {
        const home = '/home/fixture';
        const tail = rest.join('/');
        assert.equal(expandHome('~', home), home);
        assert.equal(expandHome(`~/${tail}`, home), path.join(home, tail));
        assert.equal(expandHome(`~${user}/${tail}`, home), `~${user}/${tail}`, '~user must stay literal');
      },
    ),
  },
  {
    name: 'approval.decision-table',
    property: fc.asyncProperty(
      fc.record({
        kind: fc.constantFrom('approval', 'question'),
        toolName: fc.constantFrom(
          'shell',
          'bash',
          'read_file',
          'apply_patch',
          'sandbox_network_access',
          'propose_goal',
          'mcp__x',
        ),
        explicitUser: fc.boolean(),
        deniedRead: fc.boolean(),
        docker: fc.boolean(),
        grants: fc.subarray(['unsandboxed-once', 'network-allow-once', 'allow-project', 'allow-folder-session']),
      }),
      fc.constantFrom('off', 'advisory', 'auto', 'always', undefined),
      fc.constantFrom('off', 'advisory', 'auto', 'always', undefined),
      fc.oneof(
        fc.constant('throws'),
        fc.constant('none'),
        fc.record({
          approved: fc.boolean(),
          reasoning: fc.string({ maxLength: 8 }),
          model: fc.constant('m'),
          source: fc.constantFrom('llm', 'system'),
          riskLevel: fc.constantFrom('low', 'medium', 'high'),
          authorization: fc.constantFrom('explicit', 'implied', 'weak', 'unknown'),
          confidence: fc.constantFrom('high', 'low'),
          isError: fc.boolean(),
        }),
      ),
      fc.boolean(),
      async (shape, mode, modeAfter, verdict, abort) => {
        const request = {
          kind: shape.kind,
          toolName: shape.toolName,
          input: { command: 'x' },
          grants: shape.grants,
          presentation: {
            ...(shape.explicitUser ? { requiresExplicitUser: true } : {}),
            ...(shape.deniedRead ? { deniedRead: { path: '/x' } } : {}),
          },
        };
        const profile = describeApproval(request, { isDockerHostControl: () => shape.docker });
        const route = routeApproval(mode, profile);
        if (profile.hardGate) assert.equal(route, 'ask_user', 'a hard gate was routed to review');
        if (mode !== 'auto' && mode !== 'advisory') assert.equal(route, 'ask_user', 'reviewed outside auto/advisory');
        const controller = new AbortController();
        let calls = 0;
        const result = await decideApproval({
          request,
          profile,
          signal: controller.signal,
          currentMode: () => (calls === 0 ? mode : modeAfter),
          review: async () => {
            calls += 1;
            if (abort) controller.abort();
            if (verdict === 'throws') throw new Error('model down');
            return verdict === 'none' ? undefined : verdict;
          },
        });
        if (route !== 'review') assert.equal(calls, 0, 'reviewed a request routed to a person');
        if (!result.approved) return;
        assert.equal(route, 'review');
        assert.equal(mode, 'auto', 'approved outside auto mode');
        assert.equal(modeAfter, mode, 'approved although the mode changed during review');
        assert.equal(abort, false, 'approved after abort');
        assert.ok(typeof verdict === 'object' && !verdict.isError, 'approved without a usable verdict');
        // Independent statement of the one threshold (owner decision, approval-arbiter.md).
        assert.ok(
          verdict.approved &&
            verdict.source === 'llm' &&
            ['low', 'medium'].includes(verdict.riskLevel) &&
            ['explicit', 'implied'].includes(verdict.authorization) &&
            verdict.confidence === 'high',
          'approved below the one threshold',
        );
        const oneTime = ['unsandboxed-once', 'network-allow-once'].find((g) => shape.grants.includes(g));
        assert.equal(result.grant, oneTime, "auto-answer grant differs from the request's one-time grant");
      },
    ),
  },
];
