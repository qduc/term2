"""/providers manager branches. The scratch settings hold one custom provider, mockprov."""

P = '/providers<enter>'
CUSTOM = [P, '<down>', '<enter>', 'zzzz', '<enter>']  # Add Provider → presets filtered to Custom endpoint → wizard name
SCENARIOS = {
    'prov-list': [P],
    'prov-list-down': [P, '<down>'],
    'prov-list-esc': [P, '<esc>'],
    'prov-presets': [P, '<down>', '<enter>'],
    'prov-presets-filter': [P, '<down>', '<enter>', 'open'],
    'prov-presets-down': [P, '<down>', '<enter>', '<down>'],
    'prov-presets-esc': [P, '<down>', '<enter>', '<esc>'],
    'prov-wizard-name': CUSTOM,
    'prov-wizard-name-typed': CUSTOM + ['my-llm'],
    'prov-wizard-name-bad': CUSTOM + ['bad name!', '<enter>'],
    'prov-wizard-name-esc': CUSTOM + ['<esc>'],
    'prov-wizard-type': CUSTOM + ['my-llm', '<enter>'],
    'prov-wizard-type-down': CUSTOM + ['my-llm', '<enter>', '<down>'],
    'prov-discard': CUSTOM + ['my-llm', '<enter>', '<esc>'],
    'prov-discard-yes': CUSTOM + ['my-llm', '<enter>', '<esc>', '<up>', '<enter>'],
    'prov-discard-no': CUSTOM + ['my-llm', '<enter>', '<esc>', '<enter>'],
    'prov-wizard-url': CUSTOM + ['my-llm', '<enter>', '<enter>'],
    'prov-wizard-url-typed': CUSTOM + ['my-llm', '<enter>', '<enter>', 'http://127.0.0.1:9/v1'],
    'prov-wizard-url-bad': CUSTOM + ['my-llm', '<enter>', '<enter>', 'nope', '<enter>'],
    'prov-wizard-key': CUSTOM + ['my-llm', '<enter>', '<enter>', 'http://127.0.0.1:9/v1', '<enter>'],
    'prov-wizard-key-typed': CUSTOM + ['my-llm', '<enter>', '<enter>', 'http://127.0.0.1:9/v1', '<enter>', 'sk-x'],
    'prov-review': CUSTOM + ['my-llm', '<enter>', '<enter>', 'http://127.0.0.1:9/v1', '<enter>', 'sk-x', '<enter>'],
    'prov-review-up': CUSTOM
    + ['my-llm', '<enter>', '<enter>', 'http://127.0.0.1:9/v1', '<enter>', 'sk-x', '<enter>', '<up>'],
    'prov-review-esc': CUSTOM
    + ['my-llm', '<enter>', '<enter>', 'http://127.0.0.1:9/v1', '<enter>', 'sk-x', '<enter>', '<esc>'],
    'prov-edit': [P, '<enter>'],
    'prov-edit-down': [P, '<enter>', '<down>', '<down>'],
    'prov-edit-name': [P, '<enter>', '<enter>'],
    'prov-edit-type': [P, '<enter>', '<down>', '<enter>'],
    'prov-edit-url': [P, '<enter>', '<down>', '<down>', '<enter>'],
    'prov-edit-key': [P, '<enter>', '<down>', '<down>', '<down>', '<enter>'],
    'prov-edit-esc': [P, '<enter>', '<esc>'],
    'prov-delete': [P, '<del>'],
    'prov-delete-up': [P, '<del>', '<up>'],
    'prov-delete-esc': [P, '<del>', '<esc>'],
}
