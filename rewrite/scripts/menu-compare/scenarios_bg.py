"""Background subagent approvals (solo/approvals): the child's shell call asks in the same prompt."""

_BG = {
    'replies': [
        {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'worker', 'task': 'SUBTASK remove gone.txt'}},
        {'text': 'launched'},
    ],
    'routes': [{'match': 'SUBTASK', 'replies': [
        {'tool': 'shell', 'args': {'command': 'rm -f gone.txt'}},
        {'text': 'child done'},
    ]}],
    'files': {'gone.txt': 'x\n'},
}
_GO = ['delegate it', '<enter>', '<sleep>']

def _child(args):
    seed = dict(_BG, settings={'app': {'activeProfileId': 'builtin:pair'}})
    seed['replies'] = [{'tool': 'run_subagent', 'args': args}, {'text': 'launched'}]
    return seed


SCENARIOS = {
    'bg-approval': _GO,
    'fg-spec-approval': _GO,
    'fg-explorer-approval': _GO,
    'bg-explorer-rm': _GO,
    'bg-spec-shell': _GO,
    'script-child': _GO,
    'script-child-file': _GO,
}
SEED = {name: _BG for name in SCENARIOS}
SEED['fg-spec-approval'] = _child({'execution': 'foreground', 'agent_spec': {'goal': 'SUBTASK remove gone.txt', 'tools': ['shell']}})
SEED['fg-explorer-approval'] = _child({'execution': 'foreground', 'role': 'explorer', 'task': 'SUBTASK remove gone.txt'})
SEED['bg-explorer-rm'] = dict(_child({'execution': 'background', 'role': 'explorer', 'task': 'SUBTASK remove gone.txt'}), settings={})
SEED['bg-spec-shell'] = dict(_child({'execution': 'background', 'agent_spec': {'goal': 'SUBTASK remove gone.txt', 'tools': ['shell']}}), settings={})
SEED['script-child'] = dict(_child(None), settings={})
SEED['script-child']['replies'] = [
    {'tool': 'run_code', 'args': {'description': 'Delegate removal', 'code': "const r = await agent.run({ spec: { goal: 'SUBTASK remove gone.txt', tools: ['shell'] } }); return r;"}},
    {'text': 'launched'},
]
SEED['script-child-file'] = dict(SEED['script-child'])
SEED['script-child-file']['replies'] = [
    {'tool': 'run_code', 'args': {'description': 'Delegate a file', 'code': "return await agent.run({ spec: { goal: 'SUBTASK write a file', tools: ['create_file'], permissions: { filesystem: { write: ['.'] } } } });"}},
    {'text': 'launched'},
]
SEED['script-child-file']['routes'] = [{'match': 'SUBTASK', 'replies': [
    {'tool': 'create_file', 'args': {'path': 'note.txt', 'content': 'hello\n'}},
    {'text': 'child done'},
]}]

# A read-only script child reading outside the workspace asks in the root prompt.
SCENARIOS['script-child-read'] = _GO
SEED['script-child-read'] = dict(SEED['script-child'])
SEED['script-child-read']['replies'] = [
    {'tool': 'run_code', 'args': {'description': 'Delegate a read', 'code': "return await agent.run({ spec: { goal: 'SUBTASK read hostname', tools: ['read_file'] } });"}},
    {'text': 'launched'},
]
SEED['script-child-read']['routes'] = [{'match': 'SUBTASK', 'replies': [
    {'tool': 'read_file', 'args': {'path': '/etc/hostname'}},
    {'text': 'child done'},
]}]

# A background worker reading outside the workspace.
SCENARIOS['bg-read'] = _GO
SEED['bg-read'] = dict(_BG)
SEED['bg-read']['routes'] = SEED['script-child-read']['routes']

# A background explorer reading outside the workspace.
SCENARIOS['bg-explorer-read'] = _GO
SEED['bg-explorer-read'] = dict(SEED['bg-explorer-rm'])
SEED['bg-explorer-read']['routes'] = SEED['script-child-read']['routes']

# Key paths on a script child's request.
for _name, _keys in {
    'nested-y': ['y', '<sleep>'],
    'nested-n-reason': ['n', '<sleep>', 'not that', '<enter>', '<sleep>'],
    'nested-esc': ['<esc>', '<sleep>'],
    'nested-folder': ['<down>', '<enter>', '<sleep>'],
}.items():
    SCENARIOS[_name] = _GO + _keys
    SEED[_name] = SEED['script-child-read']

# "Allow this folder for this session" on a script child's read: its next read in /etc does not ask.
SCENARIOS['nested-folder-again'] = _GO + ['<down>', '<enter>', '<sleep>']
SEED['nested-folder-again'] = dict(SEED['script-child-read'])
SEED['nested-folder-again']['routes'] = [{'match': 'SUBTASK', 'replies': [
    {'tool': 'read_file', 'args': {'path': '/etc/hostname'}},
    {'tool': 'read_file', 'args': {'path': '/etc/os-release'}},
    {'text': 'child done'},
]}]
SCENARIOS['nested-once-again'] = _GO + ['<enter>', '<sleep>']
SEED['nested-once-again'] = SEED['nested-folder-again']

# An invalid async name: legacy's schema check answers with its 'Tool input did not match schema' feedback.
SCENARIOS['bg-bad-name'] = _GO
SEED['bg-bad-name'] = dict(_child({'execution': 'background', 'role': 'explorer', 'name': 'Bad Name', 'task': 'SUBTASK look'}), settings={})

# Any tool: invalid input is legacy's schema diagnostic and a failed row, with no approval asked.
SCENARIOS['bad-shell-args'] = _GO
SEED['bad-shell-args'] = dict(_BG, settings={}, routes=[])
SEED['bad-shell-args']['replies'] = [{'tool': 'shell', 'args': {'cmd': 'ls'}}, {'text': 'launched'}]

# Legacy session reuse: a second background librarian run carries the first one's conversation.
SCENARIOS['bg-librarian-reuse'] = _GO + ['again', '<enter>', '<sleep>', '<sleep>']
SEED['bg-librarian-reuse'] = dict(_BG, settings={}, files={})
SEED['bg-librarian-reuse']['replies'] = [
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'librarian', 'task': 'LIBONE recall'}},
    {'text': 'launched'},
    {'text': 'noted'},
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'librarian', 'task': 'LIBTWO recall'}},
    {'text': 'launched again'},
    {'text': 'noted again'},
]
SEED['bg-librarian-reuse']['routes'] = [{'match': 'LIB', 'replies': [{'text': 'lib one done'}, {'text': 'lib two done'}]}]
# continue_run_id of an unknown run: legacy's not_found error.
SCENARIOS['bg-continue-unknown'] = _GO
SEED['bg-continue-unknown'] = dict(_child({'execution': 'background', 'role': 'explorer', 'task': 'SUBTASK more', 'continue_run_id': 'nope'}), settings={})
