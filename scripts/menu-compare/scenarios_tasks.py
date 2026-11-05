"""Tasks panel (solo/approvals): placement, rows and the ^G manager, as legacy."""

_BG_SHELL = {'replies': [
    {'tool': 'shell', 'args': {'command': 'sleep 60', 'background': True}},
    {'text': 'started'},
]}
_FG_SHELL = {'replies': [
    {'tool': 'shell', 'args': {'command': 'sleep 60', 'timeout_ms': 90000}},
    {'text': 'done'},
]}
_GO = ['run it', '<enter>', '<sleep>', 'y', '<sleep>']

SCENARIOS = {
    'tasks-bg-shell': _GO,
    'tasks-bg-shell-manage': _GO + ['<c-g>', '<sleep>'],
    'tasks-fg-shell': _GO,
    'tasks-fg-shell-manage': _GO + ['<c-g>', '<sleep>'],
}
SEED = {
    'tasks-bg-shell': _BG_SHELL,
    'tasks-bg-shell-manage': _BG_SHELL,
    'tasks-fg-shell': _FG_SHELL,
    'tasks-fg-shell-manage': _FG_SHELL,
}

# The shell approval itself: legacy's turn approval carries only the command, so no Timeout row.
SCENARIOS['tasks-fg-shell-prompt'] = ['run it', '<enter>', '<sleep>']
SEED['tasks-fg-shell-prompt'] = _FG_SHELL
# Down/Enter and Esc inside the ^G manager.
SCENARIOS['tasks-bg-shell-manage-down'] = _GO + ['<c-g>', '<sleep>', '<down>', '<sleep>']
SCENARIOS['tasks-bg-shell-manage-enter'] = _GO + ['<c-g>', '<sleep>', '<enter>', '<sleep>']
SCENARIOS['tasks-bg-shell-manage-esc'] = _GO + ['<c-g>', '<sleep>', '<esc>', '<sleep>']
for _name in ('tasks-bg-shell-manage-down', 'tasks-bg-shell-manage-enter', 'tasks-bg-shell-manage-esc'):
    SEED[_name] = _BG_SHELL

# A background shell that finishes: legacy's "Background shell completed" row above the follow-up reply.
SCENARIOS['tasks-bg-shell-done'] = _GO + ['<sleep>']
SEED['tasks-bg-shell-done'] = {'replies': [
    {'tool': 'shell', 'args': {'command': 'echo hi', 'background': True}},
    {'text': 'started'},
    {'text': 'noted'},
]}
