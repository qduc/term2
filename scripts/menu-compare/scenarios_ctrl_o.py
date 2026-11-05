"""Ctrl+O replaces the draft with `/model ` (legacy use-app-keyboard-shortcuts.ts:365): idle, with a draft, after a shell row, after a tool row and mid-stream."""
_TOOL = {'replies': [{'tool': 'shell', 'args': {'command': 'echo hi', 'description': 'Write and read the file'}}, {'text': 'done'}],
         'settings': {'shell': {'autoApproveMode': 'always'}}}
SCENARIOS = {
    'ctrl-o-idle': ['<c-o>'],
    'ctrl-o-draft': ['some draft', '<c-o>'],
    'ctrl-o-draft-esc': ['some draft', '<c-o>', '<esc>'],
    'ctrl-o-bang': ['!pwd ', '<enter>', '<sleep>', '<c-o>'],
    'ctrl-o-tool': ['run it', '<enter>', '<sleep>', '<sleep>', '<c-o>'],
    'ctrl-o-stream': ['hello', '<enter>', '<sleep>', '<c-o>'],
}
SEED = {'ctrl-o-tool': _TOOL, 'ctrl-o-stream': {'replies': [{'text': 'PARTIAL-REPLY', 'hold': 20}]}}
