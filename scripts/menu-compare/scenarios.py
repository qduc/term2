"""Key sequences for each menu branch. Steps are typed in order; <key> names are in screen.py KEYS.

Each menu keeps its scenarios in its own `scenarios_<menu>.py` defining SCENARIOS and optionally SEED
(per-scenario {'settings': {...}, 'files': {...}}); they are merged here.
"""
import glob
import importlib
import os


SCENARIOS = {
    'idle': [],
    'slash': ['/'],
    'slash-filter': ['/se'],
    'slash-down': ['/', '<down>', '<down>'],
    'slash-esc': ['/', '<esc>'],
    'slash-tab': ['/mod', '<tab>'],
    'slash-tab-type': ['/mod', '<tab>', 'x'],
    'slash-enter-usage': ['/usa', '<enter>'],
    'slash-enter-goal': ['/goa', '<enter>'],
    'slash-pgdn': ['/', '<pgdn>'],
    'slash-none': ['/zzz'],
    'model': ['/model '],
    'model-tab-all': ['/model ', '<tab>'],
    'model-tab-nick': ['/model ', '<tab>', '<tab>'],
    'model-filter': ['/model ', 'beta'],
    'model-fav': ['/model ', '<tab>', '<down>', '<c-f>'],
    'model-nickname': ['/model ', '<c-n>'],
    'settings': ['/settings '],
    'settings-tab': ['/settings ', '<tab>'],
    'settings-filter': ['/settings ', 'log'],
    'settings-value': ['/settings ', '<enter>'],
    'settings-reset': ['/settings reset '],
    'effort': ['/effort '],
    'auto-approve': ['/auto-approve '],
    'resume': ['/resume '],
    'profile': ['/profile '],
    'skills': ['/skills '],
    'path': ['@'],
    'path-filter': ['@REA'],
    'rewind': ['/rewind<enter>'],
    'copy': ['/copy<enter>'],
}

SEED = {
    'path': {'files': {'README.md': 'x\n', 'src/index.ts': 'x\n', 'docs/guide.md': 'x\n'}},
    'path-filter': {'files': {'README.md': 'x\n', 'src/index.ts': 'x\n', 'docs/guide.md': 'x\n'}},
}

for _path in sorted(glob.glob(os.path.join(os.path.dirname(__file__), 'scenarios_*.py'))):
    _module = importlib.import_module(os.path.basename(_path)[:-3])
    SCENARIOS.update(_module.SCENARIOS)
    SEED.update(getattr(_module, 'SEED', {}))
