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
}
SEED = {name: _SHELL for name in SCENARIOS}
