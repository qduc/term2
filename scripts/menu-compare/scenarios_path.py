"""`@` path completion branches."""

_FILES = {'files': {f'src/file{i}.ts': 'x\n' for i in range(14)} | {'README.md': 'x\n', 'docs/guide.md': 'x\n'}}

SCENARIOS = {
    'path-down': ['@', '<down>', '<down>'],
    'path-scroll': ['@', '<pgdn>'],
    'path-enter': ['look at @READ', '<enter>'],
    'path-tab': ['@READ', '<tab>'],
    'path-dir': ['@doc', '<enter>'],
    'path-esc': ['@READ', '<esc>'],
    'path-none': ['@zzzz'],
    'path-mid': ['see @src/file1'],
}
SEED = {name: _FILES for name in SCENARIOS}

SCENARIOS.update({
    'path-nomatch-enter': ['hi @zzzz', '<enter>'],
    'path-dir-continue': ['@doc', '<enter>', 'g'],
})
SEED.update({name: _FILES for name in SCENARIOS})

_E2E = {'files': {'src/alpha.ts': 'a', 'notes.txt': 'n', 'node_modules/alphabet.js': 'x'}}
SCENARIOS.update({
    'path-e2e-alp': ['look at @alp'],
    'path-e2e-dir': ['@sr', '<tab>'],
    'path-e2e-word': ['thanks @claude', '<enter>'],
})
SEED.update({'path-e2e-alp': _E2E, 'path-e2e-dir': _E2E, 'path-e2e-word': _E2E})
