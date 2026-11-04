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
