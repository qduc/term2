import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { canonicalPath, expandHome, lexicalPath } from '../../src/tools/path-identity.ts';
import { SessionAccessState } from '../../src/session/session/session-access-state.ts';

// Contract (src/tools/path-identity.ts, SessionAccessState): a session grant is
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
        const allows = (t) => (kind === 'read' ? access.allowsRead(t, fixture.base) : access.allowsEdit(t, fixture.base));
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
];
