"""Resume, profile, skills, copy and rewind menus."""

_TWO_SESSIONS = {'sessions': [['first saved question'], ['second saved question about tests']]}

SCENARIOS = {
    'resume-empty': ['/resume ', '<sleep>'],
    'resume-list': ['/resume ', '<sleep>'],
    'resume-down': ['/resume ', '<sleep>', '<down>'],
    'resume-filter': ['/resume ', '<sleep>', 'tests'],
    'resume-filter-none': ['/resume ', '<sleep>', 'zzz'],
    'resume-esc': ['/resume ', '<esc>'],
    'resume-bare': ['/resume', '<enter>', '<sleep>'],
}

SEED = {name: _TWO_SESSIONS for name in SCENARIOS if name != 'resume-empty'}

SCENARIOS['resume-enter'] = ['/resume ', '<sleep>', '<enter>', '<sleep>']
SEED['resume-enter'] = _TWO_SESSIONS

SCENARIOS.update({
    'profile-open': ['/profile '],
    'profile-filter': ['/profile ', 'ba'],
    'profile-retired': ['/profile ', 'plan'],
    'profile-none': ['/profile ', 'zzz'],
    'profile-esc': ['/profile ', '<esc>'],
    'profile-enter': ['/profile ', '<enter>', '<sleep>'],
    'profile-bare': ['/profile', '<enter>'],
})

_SKILLS = {'files': {
    '.agents/skills/dogfood/SKILL.md': '---\nname: dogfood\ndescription: Scratch dogfood skill for testing\n---\nDOGFOOD\n',
    '.agents/skills/release/SKILL.md': '---\nname: release\ndescription: Cut a release of the project\n---\nRELEASE\n',
}}
SCENARIOS.update({
    'skills-empty': ['/skills '],
    'skills-open': ['/skills '],
    'skills-down': ['/skills ', '<down>'],
    'skills-filter': ['/skills ', 'rel'],
    'skills-none': ['/skills ', 'zzz'],
    'skills-esc': ['/skills ', '<esc>'],
    'skills-enter': ['/skills ', '<enter>'],
    'skills-cancel': ['/skills ', '<enter>', '<esc>'],
    'skills-send': ['/skills ', '<enter>', 'check it', '<enter>', '<sleep>'],
    'skills-bare': ['/skills', '<enter>'],
})
SEED.update({name: _SKILLS for name in SCENARIOS if name.startswith('skills-') and name != 'skills-empty'})
SCENARIOS['skills-typed'] = ['/skills dogfood go', '<enter>', '<sleep>']
SEED['skills-typed'] = _SKILLS

_BLOCKS = {'replies': [{'text': 'Two ways:\n\n```sh\nnpm test\n```\n\nor\n\n```sh\npnpm test --watch\n```\n'}]}
_ASKED = ['show me', '<enter>', '<sleep>']
SCENARIOS.update({
    'copy-menu': _ASKED + ['/copy', '<enter>'],
    'copy-down': _ASKED + ['/copy', '<enter>', '<down>'],
    'copy-enter': _ASKED + ['/copy', '<enter>', '<enter>', '<sleep>'],
    'copy-esc': _ASKED + ['/copy', '<enter>', '<esc>'],
    'copy-nothing': ['/copy', '<enter>'],
    'copy-single': _ASKED + ['/copy', '<enter>', '<sleep>'],
    'copy-bad': _ASKED + ['/copy x', '<enter>'],
    'copy-far': _ASKED + ['/copy 3', '<enter>'],
})
SEED.update({name: _BLOCKS for name in ('copy-menu', 'copy-down', 'copy-enter', 'copy-esc', 'copy-bad', 'copy-far')})
SEED['copy-single'] = {'replies': [{'text': 'Just run the tests.'}]}

_TWO_TURNS = {'replies': [{'text': 'First answer.'}, {'text': 'Second answer.'}, {'text': 'Third answer.'}]}
_TALKED = ['original question', '<enter>', '<sleep>', 'follow-up question', '<enter>', '<sleep>']
SCENARIOS.update({
    'rewind-empty': ['/rewind ', '<enter>'],
    'rewind-open': _TALKED + ['/rewind ', '<enter>'],
    'rewind-up': _TALKED + ['/rewind ', '<enter>', '<up>'],
    'rewind-tab': _TALKED + ['/rewind ', '<enter>', '<tab>'],
    'rewind-esc': _TALKED + ['/rewind ', '<enter>', '<esc>'],
    'rewind-enter': _TALKED + ['/rewind ', '<enter>', '<up>', '<enter>', '<sleep>'],
    'rewind-resend': _TALKED + ['/rewind ', '<enter>', '<tab>', '<enter>', '<sleep>'],
    'undo-open': _TALKED + ['/undo ', '<enter>'],
    'retry-last': _TALKED + ['/retry ', '<enter>', '<sleep>'],
    'rewind-number': _TALKED + ['/rewind 1', '<enter>', '<sleep>'],
    'rewind-far': _TALKED + ['/rewind 9', '<enter>'],
    'rewind-junk': _TALKED + ['/rewind foo', '<enter>'],
})
SEED.update({name: _TWO_TURNS for name in SCENARIOS if name.startswith(('rewind-', 'undo-', 'retry-')) and name != 'rewind-empty'})
