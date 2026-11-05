"""Tool approval prompt (solo/approvals, soak 14-21): shell `rm -f gone.txt` with autoApprove off."""

_SHELL = {'replies': [
    {'tool': 'shell', 'args': {'command': 'rm -f gone.txt'}},
    {'text': 'done'},
], 'files': {'gone.txt': 'x\n'}}
SCENARIOS = {
    'approval': ['delete it', '<enter>'],
    'approval-down': ['delete it', '<enter>', '<down>'],
    'approval-allow': ['delete it', '<enter>', '<enter>'],
    'approval-y': ['delete it', '<enter>', 'y'],
    'approval-1': ['delete it', '<enter>', '1'],
    'approval-deny': ['delete it', '<enter>', '<down>', '<enter>'],
    'approval-n': ['delete it', '<enter>', 'n'],
    'approval-n-reason': ['delete it', '<enter>', 'n', 'not now'],
    'approval-n-reason-enter': ['delete it', '<enter>', 'n', 'not now', '<enter>'],
    'approval-n-esc': ['delete it', '<enter>', 'n', '<esc>'],
    'approval-esc': ['delete it', '<enter>', '<esc>'],
    'approval-esc-again': ['delete it', '<enter>', '<esc>', 'hello', '<enter>'],
    'approval-ctrl-c': ['delete it', '<enter>', '<c-c>'],
    'approval-ctrl-g': ['delete it', '<enter>', '<c-g>'],
    # A second Ctrl+G after the first: legacy has no pending-interactions list.
    'approval-ctrl-g-again': ['delete it', '<enter>', '<c-g>', '<sleep>', '<c-g>', '<sleep>'],
    'approval-ctrl-g-again-enter': ['delete it', '<enter>', '<c-g>', '<sleep>', '<c-g>', '<sleep>', '<enter>', '<sleep>'],
}
_DRAFT = ['delete it', '<enter>', 'my draft', '<sleep>']
SCENARIOS.update({
    'draft-approval': _DRAFT,
    'draft-n': _DRAFT + ['n'],
    'draft-n-type': _DRAFT + ['n', ' now'],
    'draft-deny': _DRAFT + ['<down>', '<enter>'],
    'draft-n-esc': _DRAFT + ['n', '<esc>'],
    'draft-n-enter': _DRAFT + ['n', '<enter>'],
    'draft-n-ctrl-c': _DRAFT + ['n', '<c-c>'],
    'draft-allow': _DRAFT + ['y'],
})
SEED = {name: _SHELL for name in SCENARIOS}
_SLOW = dict(_SHELL, replies=[dict(_SHELL['replies'][0], delay=2)] + _SHELL['replies'][1:])
SEED.update({name: _SLOW for name in SCENARIOS if name.startswith('draft-')})
