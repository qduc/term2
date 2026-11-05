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

# continue_run_id of a completed run: the continuation keeps the run's ID and carries its conversation.
SCENARIOS['bg-continue'] = _GO + ['again', '<enter>', '<sleep>', '<sleep>']
SEED['bg-continue'] = dict(_BG, settings={}, files={})
SEED['bg-continue']['replies'] = [
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'explorer', 'task': 'SUBTASK one'}},
    {'text': 'launched'},
    {'text': 'noted'},
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'explorer', 'task': 'SUBTASK two',
                                      'continue_run_id': '$RUNID'}},
    {'text': 'launched again'},
    {'text': 'noted again'},
]
SEED['bg-continue']['routes'] = [{'match': 'SUBTASK', 'replies': [{'text': 'sub one done'}, {'text': 'sub two done'}]}]

# A background worker's file write: its completion notice carries Diff stat and Files changed.
SCENARIOS['bg-worker-file'] = _GO + ['<sleep>']
SEED['bg-worker-file'] = dict(_BG, settings={}, files={})
SEED['bg-worker-file']['replies'] = [
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'worker', 'task': 'SUBTASK write a file'}},
    {'text': 'launched'},
    {'text': 'noted'},
]
SEED['bg-worker-file']['routes'] = SEED['script-child-file']['routes']

# A background worker pinned to a missing worktree: a failed run with the pin error, not a launch refusal.
SCENARIOS['bg-worktree-missing'] = _GO + ['<sleep>']
SEED['bg-worktree-missing'] = dict(_BG, settings={}, files={})
SEED['bg-worktree-missing']['replies'] = [
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'worker', 'task': 'SUBTASK write a file',
                                      'worktree': 'nowhere'}},
    {'text': 'launched'},
    {'text': 'noted'},
]

# A background child's provider retry: the ^G manager's Last observed row names it.
SCENARIOS['bg-retry-manage'] = _GO + ['<c-g>', '<sleep>', '<enter>', '<sleep>']
SEED['bg-retry-manage'] = dict(_BG, files={}, settings={'agent': {'retryAttempts': 2, 'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}}})
SEED['bg-retry-manage']['replies'] = [
    {'tool': 'run_subagent', 'args': {'execution': 'background', 'role': 'explorer', 'task': 'SUBTASK look'}},
    {'text': 'launched'},
    {'text': 'noted'},
]
SEED['bg-retry-manage']['routes'] = [{'match': 'SUBTASK', 'replies': [{'status': 429}, {'text': 'child done', 'delay': 30}]}]

# A background child's hallucinated tool: legacy's model-behavior retry, which Last activity names.
SCENARIOS['bg-badtool-manage'] = SCENARIOS['bg-retry-manage']
SEED['bg-badtool-manage'] = dict(SEED['bg-retry-manage'])
SEED['bg-badtool-manage']['routes'] = [{'match': 'SUBTASK', 'replies': [
    {'tool': 'frobnicate', 'args': {}}, {'text': 'child done', 'delay': 30}]}]

# A background child's unparseable tool arguments.
SCENARIOS['bg-badjson-manage'] = SCENARIOS['bg-retry-manage']
SEED['bg-badjson-manage'] = dict(SEED['bg-retry-manage'])
SEED['bg-badjson-manage']['routes'] = [{'match': 'SUBTASK', 'replies': [
    {'tool': 'read_file', 'raw_args': '{"path": "x', 'args': {}}, {'text': 'child done', 'delay': 30}]}]

# A background child's empty model response: legacy's model-behavior retry ("Retrying 1 of 2").
SCENARIOS['bg-empty-manage'] = SCENARIOS['bg-retry-manage']
SEED['bg-empty-manage'] = dict(SEED['bg-retry-manage'])
SEED['bg-empty-manage']['routes'] = [{'match': 'SUBTASK', 'replies': [{'empty': True}, {'text': 'child done', 'delay': 30}]}]

# The root's own unknown tool and bad JSON: legacy shows each as a failed tool row.
SCENARIOS['root-badtool'] = ['go', '<enter>', '<sleep>']
SEED['root-badtool'] = {'replies': [{'tool': 'frobnicate', 'args': {}}, {'text': 'done'}]}
SCENARIOS['root-badjson'] = ['go', '<enter>', '<sleep>']
SEED['root-badjson'] = {'replies': [{'tool': 'read_file', 'raw_args': '{"path": "x', 'args': {}}, {'text': 'done'}]}
# A known tool name the profile doesn't offer (Bare has no create_file): legacy's row claims "✓ Created"
# although nothing ran (#136 item 14, a confirmed legacy bug next fixes; see accepted-differences).
SCENARIOS['root-unoffered-create'] = ['go', '<enter>', '<sleep>']
SEED['root-unoffered-create'] = {'replies': [{'tool': 'create_file', 'args': {'path': 'note.txt', 'content': 'hello\n'}}, {'text': 'done'}]}
