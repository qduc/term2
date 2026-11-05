"""Real-terminal soak items (rewrite/parity/real-terminal/report/soak-differences.md) not covered elsewhere."""

_LONG = ('please look through the whole repository and explain in detail how the menu stack decides which '
         'menu is active when several trigger rules match the same composer text at once')
_MANY = {'sessions': [[f'saved question number {i}'] for i in range(12)]}
_RESUMED = {'sessions': [['short first turn', _LONG, 'third turn', _LONG + ' again', 'fifth turn']]}

SCENARIOS = {
    'slash-filter-re': ['/re'],                                   # item 25
    'slash-tab-re': ['/re', '<tab>', '<sleep>'],                  # item 26: Tab runs the highlighted command
    'resume-pgdn': ['/resume ', '<sleep>', '<pgdn>'],             # item 56
    'undo-resumed': ['/resume ', '<sleep>', '<enter>', '<sleep>', '/undo ', '<enter>'],  # item 52
    'rewind-long': [_LONG, '<enter>', '<sleep>', 'short follow-up', '<enter>', '<sleep>', '/rewind ', '<enter>'],
}
SEED = {
    'resume-pgdn': _MANY,
    'undo-resumed': _RESUMED,
    'rewind-long': {'replies': [{'text': 'First answer.'}, {'text': 'Second answer.'}]},
}
