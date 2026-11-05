"""ask_user question prompt (solo/approvals): the Pair profile has ask_user; Bare does not."""

_PAIR = {'app': {'activeProfileId': 'builtin:pair'}}


def _ask(*questions):
    return {'settings': _PAIR, 'replies': [{'tool': 'ask_user', 'args': {'questions': list(questions)}}, {'text': 'done'}]}


_COLOUR = {'question': 'Pick a colour?', 'options': [
    {'label': 'Amber', 'description': 'A warm yellow-orange.'}, {'label': 'Violet'}]}
_MULTI = {'question': 'Which fruits?', 'is_multi_select': True,
          'options': [{'label': 'Apple'}, {'label': 'Pear'}, {'label': 'Plum'}]}
_SIZE = {'question': 'Which size?', 'options': [{'label': 'Small'}, {'label': 'Large'}]}

_GO = ['ask me', '<enter>']
SCENARIOS = {
    'ask': _GO,
    'ask-down': _GO + ['<down>'],
    'ask-down-other': _GO + ['<down>', '<down>'],
    'ask-up': _GO + ['<up>'],
    'ask-enter': _GO + ['<enter>'],
    'ask-2': _GO + ['2'],
    'ask-other': _GO + ['3'],
    'ask-other-type': _GO + ['3', 'teal'],
    'ask-other-enter': _GO + ['3', 'teal', '<enter>'],
    'ask-other-esc': _GO + ['3', '<esc>'],
    'ask-esc': _GO + ['<esc>'],
    'ask-ctrl-c': _GO + ['<c-c>'],
    'ask-ctrl-g': _GO + ['<c-g>'],
    'ask-y': _GO + ['y'],
    'ask-multi': _GO,
    'ask-multi-toggle': _GO + ['1', '3'],
    'ask-multi-space': _GO + ['<down>', ' '],
    'ask-multi-submit': _GO + ['1', '3', '4'],
    'ask-two': _GO,
    'ask-two-first': _GO + ['1'],
    'ask-two-n': _GO + ['n'],
    'ask-two-back': _GO + ['1', 'p'],
    'ask-two-done': _GO + ['1', '2'],
}
SEED = {name: _ask(_COLOUR) for name in SCENARIOS}
SEED.update({name: _ask(_MULTI) for name in SCENARIOS if name.startswith('ask-multi')})
SEED.update({name: _ask(_COLOUR, _SIZE) for name in SCENARIOS if name.startswith('ask-two')})
