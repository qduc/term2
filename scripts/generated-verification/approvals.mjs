import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { canonicalPath, expandHome, lexicalPath } from '../../src/tools/workspace/path-identity.ts';
import { SessionAccessState } from '../../src/session/session/session-access-state.ts';
import { approvalRouteFor, decideApproval, describeApproval } from '../../src/session/approval/approval-route.ts';
import { ApprovalReviews } from '../../src/session/approval/approval-arbiter.ts';
import { DirectBackgroundInteractions } from '../../src/session/background-interactions.ts';

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
  // Dangling: a write through it would create the file outside the grant.
  fs.symlinkSync(path.join(root, 'secret', 'not-yet'), path.join(root, 'data', 'deep', 'dangle'));
  // A relative dangling link reached through a symlinked folder: the kernel resolves it against
  // the link's real folder (elsewhere/), so a write lands outside the grant.
  fs.mkdirSync(path.join(root, 'elsewhere', 'inner'), { recursive: true });
  fs.symlinkSync(path.join(root, 'elsewhere', 'inner'), path.join(root, 'data', 'deep', 'via'));
  fs.symlinkSync('../missing', path.join(root, 'elsewhere', 'inner', 'rdangle'));
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
        assert.equal(
          allows(path.join(fixture.root, 'data', 'deep', 'dangle', 'new.txt')),
          false,
          'a dangling symlink inside the grant escaped it',
        );
        assert.equal(
          allows(path.join(fixture.root, 'data', 'deep', 'via', 'rdangle', 'new.txt')),
          false,
          'a relative dangling symlink behind a symlinked folder escaped the grant',
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
        // The app reports a shell call asking to leave an enabled sandbox (TUI/headless offer no grant for it).
        inputEscape: fc.boolean(),
        grants: fc.subarray(['unsandboxed-once', 'network-allow-once', 'allow-project', 'allow-folder-session']),
      }),
      fc.constantFrom('off', 'auto', 'unattended', 'always', undefined),
      fc.constantFrom('off', 'auto', 'unattended', 'always', undefined),
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
      fc.boolean(),
      fc.boolean(),
      async (shape, mode, modeAfter, verdict, abort, reviewEscapes, showReview) => {
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
        const profile = describeApproval(request, {
          isDockerHostControl: () => shape.docker,
          isSandboxEscape: () => shape.inputEscape,
        });
        const surfaceRoute = approvalRouteFor(mode, profile, { reviewEscapes, showReview });
        const route = ['decide', 'advise', 'judge'].includes(surfaceRoute.kind) ? 'review' : surfaceRoute.kind;
        const escape = shape.kind !== 'question' && (shape.grants.includes('unsandboxed-once') || shape.inputEscape);
        if (mode === 'unattended') {
          // Unattended (unattended-approval.md): nothing waits for a person except a question.
          if (shape.kind === 'question') assert.equal(route, 'ask_user', 'unattended did not ask a question');
          else assert.notEqual(route, 'ask_user', 'unattended left a request waiting for a person');
          if (profile.hardGate && shape.kind !== 'question') assert.equal(route, 'refuse', 'a hard gate was reviewed');
          if (!profile.reviewable && shape.kind !== 'question')
            assert.equal(route, 'refuse', 'an unreviewable tool was reviewed');
          if (escape && !reviewEscapes) assert.equal(route, 'refuse', 'an escape was reviewed with the setting off');
          if (escape && reviewEscapes && !profile.hardGate && profile.reviewable)
            assert.equal(route, 'review', 'the escape setting did not hand the escape to the reviewer');
        } else {
          assert.notEqual(route, 'refuse', 'a mode other than unattended refused');
          if (profile.hardGate) assert.equal(route, 'ask_user', 'a hard gate was routed to review');
          if (mode === 'always' && !profile.hardGate) assert.equal(route, 'bypass');
          if ((mode === 'off' || mode === undefined) && !showReview)
            assert.equal(route, 'ask_user', 'off reviewed without showReview');
          if ((mode === 'off' || mode === undefined) && showReview && !profile.hardGate && profile.reviewable)
            assert.equal(route, 'review', 'off+showReview lost its advisory assessment');
        }
        if (route === 'review')
          assert.equal(
            surfaceRoute.kind,
            mode === 'unattended' ? 'judge' : mode === 'auto' ? 'decide' : 'advise',
            'a reviewed request has the wrong meaning for its mode',
          );
        if (surfaceRoute.kind === 'refuse') assert.ok(surfaceRoute.reason.length > 0, 'refusal without a reason');
        const controller = new AbortController();
        let calls = 0;
        const result = await decideApproval({
          request,
          profile,
          signal: controller.signal,
          currentMode: () => (calls === 0 ? mode : modeAfter),
          routeOptions: () => ({ reviewEscapes, showReview }),
          review: async () => {
            calls += 1;
            if (abort) controller.abort();
            if (verdict === 'throws') throw new Error('model down');
            return verdict === 'none' ? undefined : verdict;
          },
        });
        if (route !== 'review') assert.equal(calls, 0, 'reviewed a request routed to a person');
        if (route === 'bypass') {
          assert.equal(result.kind, 'bypassed');
          assert.equal(result.approved, true);
          const oneTime = ['unsandboxed-once', 'network-allow-once'].find((g) => shape.grants.includes(g));
          assert.equal(result.grant, oneTime, 'bypass lost its scoped grant');
          return;
        }
        if (result.kind === 'reviewed') assert.equal(result.showReview, showReview);
        if (!result.approved) return;
        assert.equal(route, 'review');
        assert.ok(mode === 'auto' || mode === 'unattended', 'approved outside auto or unattended mode');
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
  {
    // ApprovalReviews: the first of review result and a person's stop wins; an approval
    // stands only if the current generation still routes the request to review.
    name: 'approval.arbiter-settle',
    property: fc.asyncProperty(
      fc.record({
        routedAtOpen: fc.boolean(),
        routedAtSettle: fc.boolean(),
        decidesAtSettle: fc.boolean(),
        bypassAtOpen: fc.boolean(),
        bypassAtSettle: fc.boolean(),
        outcome: fc.constantFrom('approved', 'rejected', 'throws'),
        stopBeforeResult: fc.boolean(),
        unattendedAtSettle: fc.boolean(),
      }),
      async ({
        routedAtOpen,
        routedAtSettle,
        decidesAtSettle,
        bypassAtOpen,
        bypassAtSettle,
        outcome,
        stopBeforeResult,
        unattendedAtSettle,
      }) => {
        let unattended = false;
        let routed = routedAtOpen;
        let decides = true;
        let bypass = bypassAtOpen;
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const settles = [];
        const events = [];
        const reviews = new ApprovalReviews(
          {
            willReview: () => routed,
            // Advisory assessments cannot answer; reviewed approvals and bypasses are distinct authority.
            mayApprove: () => routed && decides,
            route: () => ({ kind: routed ? (decides ? (bypass ? 'bypass' : 'decide') : 'advise') : 'ask_user' }),
            unattended: () => unattended,
            review: async () => {
              await gate;
              if (outcome === 'throws') throw new Error('model down');
              return outcome === 'approved' && bypassAtOpen
                ? { kind: 'bypassed', approved: true, grant: 'unsandboxed-once' }
                : outcome === 'approved'
                ? { kind: 'reviewed', approved: true, advisory: { approved: true, reasoning: '', model: 'm' } }
                : { kind: 'reviewed', approved: false, advisory: { approved: false, reasoning: '', model: 'm' } };
            },
          },
          () => [],
          (event) => events.push(event.phase),
        );
        const request = { requestId: 'r', turnId: 't', kind: 'approval', toolName: 'shell', input: {}, summary: 's' };
        const refusals = [];
        const began = reviews.begin(request, {
          settle: (_request, review) => settles.push(review),
          refuse: (_request, review) => refusals.push(review),
        });
        assert.equal(began, routedAtOpen, 'began a review the route did not ask for');
        if (!began) return assert.equal(settles.length, 0);
        assert.equal(reviews.has('r'), true);
        if (stopBeforeResult) assert.ok(reviews.stop('r'), 'stop did not return the held request');
        routed = routedAtSettle;
        decides = decidesAtSettle;
        bypass = bypassAtSettle;
        unattended = unattendedAtSettle;
        release();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reviews.has('r'), false, 'request still held after settle or stop');
        assert.deepEqual(events, ['started', 'settled'], 'review transient not started then settled exactly once');
        if (stopBeforeResult)
          return assert.equal(settles.length + refusals.length, 0, 'settled after a person stopped the review');
        assert.equal(settles.length + refusals.length, 1, 'settled other than exactly once');
        const approves = outcome === 'approved' && routedAtSettle && decidesAtSettle && bypassAtOpen === bypassAtSettle;
        // A non-approval follows the mode current at settle: refused in unattended, opened otherwise.
        assert.equal(
          refusals.length,
          !approves && unattendedAtSettle ? 1 : 0,
          'refusal did not follow the current mode',
        );
        const result = settles[0] ?? refusals[0];
        assert.equal(
          result.approved,
          approves,
          'approval did not follow the result and the current generation deciding',
        );
        if (outcome === 'throws') assert.equal(result.kind, 'unavailable');
      },
    ),
  },
  {
    // Unattended refusals for a background task (background-interactions.ts): every refused request is
    // opened and closed by policy in one step and never left waiting; the denial stops the task's run
    // exactly when 3 in a row or 10 in total are reached. Only an unrelated completion resets the streak.
    name: 'approval.unattended-task-limit',
    property: fc.asyncProperty(
      fc.array(fc.constantFrom('refuse-unreviewed', 'refuse-reviewed', 'approve', 'finish-other'), {
        minLength: 1,
        maxLength: 30,
      }),
      async (steps) => {
        const facts = [];
        const interactions = new DirectBackgroundInteractions((fact) => facts.push(fact));
        let next = 'approve';
        interactions.useReviews(
          new ApprovalReviews(
            {
              willReview: () => next !== 'refuse-unreviewed',
              mayApprove: () => true,
              route: () =>
                next === 'refuse-unreviewed' ? { kind: 'refuse', reason: 'fixture gate' } : { kind: 'judge' },
              unattended: () => true,
              review: async () =>
                next === 'approve'
                  ? { kind: 'reviewed', approved: true, advisory: { approved: true, reasoning: 'ok', model: 'm' } }
                  : { kind: 'reviewed', approved: false, advisory: { approved: false, reasoning: 'no', model: 'm' } },
            },
            () => [],
            undefined,
          ),
        );
        let consecutive = 0;
        let total = 0;
        let stopped = false;
        for (const [index, step] of steps.entries()) {
          if (stopped) break;
          if (step === 'finish-other') {
            consecutive = 0;
            interactions.toolFinished('task', `other${index}`);
            continue;
          }
          next = step;
          const request = {
            requestId: `r${index}`,
            executionId: `execution${index}`,
            ...(step === 'refuse-reviewed' ? { parentExecutionId: `parent${index}` } : {}),
            turnId: 't',
            taskId: 'task',
            kind: 'approval',
            toolName: 'shell',
            input: {},
            summary: `step ${index}`,
            sessionId: 's',
          };
          const decision = await interactions.open(request, new AbortController().signal, true);
          assert.equal(interactions.pending().length, 0, 'a request was left waiting for a person');
          const closed = facts.filter(
            (fact) => fact.type === 'task_interaction_closed' && fact.requestId === request.requestId,
          );
          assert.equal(closed.length, 1, 'request not closed exactly once');
          if (step === 'approve') {
            assert.equal(decision.kind, 'allow');
            continue;
          }
          consecutive += 1;
          total += 1;
          const opened = facts.find(
            (fact) => fact.type === 'task_interaction_opened' && fact.request.requestId === request.requestId,
          );
          assert.equal(opened?.review?.refused, true, 'refused open not marked refused');
          assert.equal(closed[0].resolutionSource, 'policy');
          assert.equal(decision.kind, 'deny');
          assert.match(decision.reason, /Refused by unattended approval/);
          // The build brief's values (decision 3), stated independently of the implementation.
          const limit = consecutive >= 3 || total >= 10;
          assert.equal(decision.stopAfterApprovalResolution === true, limit, 'stop did not match the limit');
          interactions.toolFinished('task', request.executionId);
          if (request.parentExecutionId) interactions.toolFinished('task', request.parentExecutionId);
          if (limit) {
            assert.match(decision.reason, /Unattended approval stopped this run/);
            stopped = true;
          }
        }
      },
    ),
  },
];
