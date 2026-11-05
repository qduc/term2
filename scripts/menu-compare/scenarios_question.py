"""ask_user question menu (build-tui-question-menu-extra-entries)."""

_ASK = {'replies': [
    {'tool': 'ask_user', 'args': {'questions': [{'question': 'Pick a colour?', 'options': [{'label': 'Amber'}, {'label': 'Violet'}]}]}},
    {'text': 'done'},
]}
SCENARIOS = {
    'question': ['ask me', '<enter>'],
    'question-down': ['ask me', '<enter>', '<down>'],
    'question-other': ['ask me', '<enter>', '<down>', '<down>', '<enter>'],
    'question-answer': ['ask me', '<enter>', '<enter>'],
    'question-esc': ['ask me', '<enter>', '<esc>'],
}
SEED = {name: _ASK for name in SCENARIOS}
