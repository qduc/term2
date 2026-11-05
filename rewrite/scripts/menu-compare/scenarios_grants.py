"""Session-grant options (solo/approvals): folder read, outside-workspace edit, docker."""

def _seed(tool, args):
    return {'replies': [{'tool': tool, 'args': args}, {'tool': tool, 'args': args}, {'text': 'done'}]}

_GO = ['do it', '<enter>', '<sleep>']
SCENARIOS = {
    'grant-read-prompt': _GO,
    'grant-edit-prompt': _GO,
    'grant-docker-prompt': _GO,
    'grant-docker-probe': _GO + ['<sleep>', '<enter>', '<sleep>', '<sleep>'],
}
SEED = {
    'grant-read-prompt': _seed('read_file', {'path': '/etc/hostname'}),
    'grant-edit-prompt': _seed('create_file', {'path': '../outside-note.txt', 'content': 'hi\n'}),
    'grant-docker-prompt': _seed('shell', {'command': 'docker ps'}),
    'grant-docker-probe': {'replies': [
        {'tool': 'shell', 'args': {'command': 'docker ps'}},
        {'tool': 'shell', 'args': {'command': 'docker images'}},
        {'text': 'done'},
    ]},
}
_PAIR = {'app': {'activeProfileId': 'builtin:pair'}}
for _name in ('grant-read-prompt', 'grant-edit-prompt'):
    SEED[_name + '-pair'] = dict(SEED[_name], settings=_PAIR)
    SCENARIOS[_name + '-pair'] = _GO

# Picking each Docker option: the second identical call asks again only after "Allow this command".
for _name, _keys in {
    'grant-docker-once': ['<enter>', '<sleep>'],
    'grant-docker-session': ['<down>', '<down>', '<enter>', '<sleep>'],
    'grant-docker-project': ['<down>', '<down>', '<down>', '<enter>', '<sleep>'],
}.items():
    SCENARIOS[_name] = _GO + ['<sleep>', '<sleep>'] + _keys + ['<sleep>']
    SEED[_name] = SEED['grant-docker-prompt']
