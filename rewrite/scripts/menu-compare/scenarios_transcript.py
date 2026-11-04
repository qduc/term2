"""Core transcript flows: start-up header, replies, tool rows, status counters, compaction, resize, resume, exit.

Compare these with FULL=1 so the whole transcript (scrollback and screen) is compared, not only the menu region.
"""

_USAGE = {'prompt_tokens': 1200, 'completion_tokens': 80}
_MD = ('# Plan\n\nHere is **bold** text, some `inline code` and a list:\n\n- first item\n- second item with a much '
       'longer line that has to wrap once the terminal is only eighty columns wide, and keeps going a bit\n\n'
       '1. one\n2. two\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nA closing paragraph.')
_LONG = ('This reply is one long paragraph that wraps across several rows at one hundred columns and even more rows '
         'at eighty columns, so the reflow after a resize shows how each CLI continues a wrapped line.')
_SHELL = {'tool': 'shell', 'args': {'command': 'echo hi', 'description': 'Print a greeting'}}
# A write needs approval (a read-only `echo` is approved on its own); no description, as in the soak.
_TOUCH = {'tool': 'shell', 'args': {'command': 'touch created-by-walk.txt'}}
_LS = {'tool': 'shell', 'args': {'command': 'ls'}}
_FAIL = {'tool': 'shell', 'args': {'command': 'exit 3', 'description': 'Fail on purpose'}}
_TURNS = ['first question', '<enter>', '<sleep>', 'second question', '<enter>', '<sleep>', 'third question', '<enter>',
          '<sleep>']

SCENARIOS = {
    't-startup': [],
    't-markdown': ['show me markdown', '<enter>', '<sleep>'],
    't-long': ['say something long', '<enter>', '<sleep>'],
    't-turns': _TURNS,
    't-stream': ['stream please', '<enter>', '<sleep>'],
    't-stream-done': ['stream please', '<enter>', '<sleep>', '<sleep>', '<sleep>', '<sleep>'],
    't-tool-auto': ['run it', '<enter>', '<sleep>', '<sleep>'],
    't-tool-ls': ['list the files', '<enter>', '<sleep>', '<sleep>'],
    't-tool-fail': ['run it', '<enter>', '<sleep>', '<sleep>'],
    't-tool-approve': ['run it', '<enter>', '<sleep>', '1', '<sleep>', '<sleep>'],
    't-tool-pending': ['run it', '<enter>', '<sleep>'],
    't-tool-deny': ['run it', '<enter>', '<sleep>', '2', '<sleep>', '<sleep>'],
    't-tool-deny-reason': ['run it', '<enter>', '<sleep>', '2', '<sleep>', 'not now', '<enter>', '<sleep>', '<sleep>'],
    't-compact': ['first question', '<enter>', '<sleep>', '/compact', '<enter>', '<sleep>', 'second question', '<enter>',
                  '<sleep>', '/compact', '<enter>', '<sleep>'],
    't-resize-down': ['say something long', '<enter>', '<sleep>', '<resize-80x24>', '<sleep>'],
    't-resize-back': ['say something long', '<enter>', '<sleep>', '<resize-80x24>', '<sleep>', '<resize-100x34>',
                      '<sleep>'],
    't-resume': ['/resume ', '<sleep>', '<enter>', '<sleep>'],
    't-status-msgs': ['/usage', '<enter>', '<sleep>', '/effort', '<enter>', '<sleep>', 'hello', '<enter>', '<sleep>'],
    't-rewind': ['first question', '<enter>', '<sleep>', 'second question', '<enter>', '<sleep>', '/rewind ', '<enter>',
                 '<sleep>', '<enter>', '<sleep>', 'third question', '<enter>', '<sleep>'],
    't-exit-fresh': ['<c-c>', '<c-c>', '<sleep>'],
    't-exit-turn': ['hello', '<enter>', '<sleep>', '<c-c>', '<c-c>', '<sleep>'],
    't-exit-cmd': ['hello', '<enter>', '<sleep>', '/exit', '<enter>', '<sleep>'],
}

SEED = {
    't-markdown': {'replies': [{'text': _MD}], 'usage': _USAGE},
    't-long': {'replies': [{'text': _LONG}], 'usage': _USAGE},
    't-turns': {'replies': [{'text': 'Answer one.'}, {'text': 'Answer two.'}, {'text': 'Answer three.'}],
                'usage': _USAGE},
    't-stream': {'replies': [{'text': 'word ' * 60, 'chunks': 30, 'delay': 0.2}], 'usage': _USAGE},
    't-stream-done': {'replies': [{'text': 'word ' * 60, 'chunks': 30, 'delay': 0.2}], 'usage': _USAGE},
    't-tool-auto': {'replies': [_SHELL, {'text': 'done'}], 'usage': _USAGE,
                    'settings': {'shell': {'autoApproveMode': 'always'}}},
    't-tool-ls': {'replies': [_LS, {'text': 'done'}], 'usage': _USAGE,
                  'settings': {'shell': {'autoApproveMode': 'always'}}},
    't-tool-fail': {'replies': [_FAIL, {'text': 'done'}], 'usage': _USAGE,
                    'settings': {'shell': {'autoApproveMode': 'always'}}},
    't-tool-approve': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-tool-pending': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-tool-deny': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-tool-deny-reason': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-compact': {'replies': [{'text': 'Answer one.'}, {'text': 'Summary of the conversation.'},
                              {'text': 'Answer two.'}, {'text': 'Summary again.'}], 'usage': _USAGE,
                  'settings': {'agent': {'retryAttempts': 0, 'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'},
                                         'contextCompaction': {'enabled': True, 'mode': 'local',
                                                               'compactThreshold': 0.8,
                                                               'compactThresholdTokens': 60000}}}},
    't-resize-down': {'replies': [{'text': _LONG}], 'usage': _USAGE},
    't-resize-back': {'replies': [{'text': _LONG}], 'usage': _USAGE},
    't-resume': {'sessions': [['short first turn', 'second turn', 'third turn']]},
    't-rewind': {'replies': [{'text': 'Answer one.'}, {'text': 'Answer two.'}, {'text': 'Answer three.'}]},
    't-exit-turn': {'replies': [{'text': 'Hi there.'}], 'usage': _USAGE},
    't-exit-cmd': {'replies': [{'text': 'Hi there.'}], 'usage': _USAGE},
}
