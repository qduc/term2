"""Model menu branches (`/model `, settings-backed `/settings agent.modelSelection `)."""

AGENT = {'retryAttempts': 0, 'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}}
FAVS = {'settings': {'agent': {**AGENT, 'favoriteModels': ['mockprov/mock-beta', 'mockprov/mock-gamma']}}}
NICKS = {'settings': {'agent': {**AGENT, 'modelNicknames': {'fast': 'mockprov/mock-alpha', 'slow': 'mockprov/mock-gamma'}}}}
# A second provider whose listing is refused: legacy's "Some providers failed" notice.
FAILING = {'extra_providers': [{'name': 'deadprov', 'type': 'openai-compatible', 'baseUrl': 'http://127.0.0.1:9/v1', 'apiKey': 'k'}]}

SCENARIOS = {
    # Tabs (zero favourites: Favorites shows legacy's behaviour; `model`/`model-tab-*` are in scenarios.py).
    'model-stab': ['/model ', '<stab>'],
    'model-left': ['/model ', '<left>'],
    'model-right2': ['/model ', '<right>', '<right>'],
    'model-favs': ['/model '],
    'model-favs-all': ['/model ', '<stab>'],
    'model-nicks': ['/model ', '<tab>'],
    'model-nicks-all': ['/model ', '<stab>'],
    # Filter.
    'model-filter-provider': ['/model ', 'mockprov'],
    'model-filter-fuzzy': ['/model ', 'gtm'],
    'model-filter-bs': ['/model ', 'beta', '<bs>', '<bs>'],
    'model-none': ['/model ', 'zzz'],
    'model-none-all': ['/model ', '<stab>', 'zzz'],
    # Navigation.
    'model-down': ['/model ', '<stab>', '<down>', '<down>'],
    'model-up-wrap': ['/model ', '<stab>', '<up>'],
    # Favorites.
    'model-unfav': ['/model ', '<c-f>'],
    'model-fav-then-favtab': ['/model ', '<stab>', '<down>', '<c-f>', '<tab>'],
    # Nickname editor.
    'model-nick-new': ['/model ', '<stab>', '<down>', '<c-n>'],
    'model-nick-type': ['/model ', '<stab>', '<down>', '<c-n>', 'quick'],
    'model-nick-save': ['/model ', '<stab>', '<down>', '<c-n>', 'quick', '<enter>'],
    'model-nick-save-tab': ['/model ', '<stab>', '<down>', '<c-n>', 'quick', '<enter>', '<tab>', '<tab>'],
    'model-nick-invalid': ['/model ', '<stab>', '<down>', '<c-n>', 'mockprov', '<enter>'],
    'model-nick-esc': ['/model ', '<stab>', '<down>', '<c-n>', 'quick', '<esc>'],
    'model-nick-esc-esc': ['/model ', '<stab>', '<down>', '<c-n>', '<esc>', '<esc>'],
    'model-nick-edit': ['/model ', '<stab>', '<c-n>'],
    'model-nick-edit-save': ['/model ', '<stab>', '<c-n>', '<bs>', '<bs>', '<bs>', '<bs>', 'zoom', '<enter>'],
    'model-nick-delete': ['/model ', '<stab>', '<c-n>', '<del>'],
    'model-nick-replace': ['/model ', '<stab>', '<down>', '<c-n>', 'fast', '<enter>'],
    'model-nick-replace-ok': ['/model ', '<stab>', '<down>', '<c-n>', 'fast', '<enter>', '<enter>'],
    'model-nick-fav': ['/model ', '<stab>', '<down>', '<c-n>', '<c-f>'],
    # Refresh, failure notice, Esc, Enter.
    'model-refresh': ['/model ', '<stab>', '<c-r>'],
    'model-failing': ['/model ', '<stab>'],
    'model-esc': ['/model ', '<esc>'],
    'model-select': ['/model ', '<stab>', '<down>', '<enter>'],
    'model-select-typed': ['/model ', '<stab>', 'gamma', '<enter>'],
    'model-select-unlisted': ['/model ', 'quick', '<enter>'],
    # Favorites tab with a filter: the rows come from every catalog, but Enter takes the typed text.
    'model-select-filter': ['/model ', 'mockprov/mock-beta', '<enter>'],
    'model-select-oneshot': ['/model mockprov/mock-beta', '<enter>'],
    'model-bare-enter': ['/model<enter>'],
    'model-ctrl-o-in-menu': ['/', '<c-o>'],
    # Settings-backed frame.
    'model-setting': ['/settings agent.modelSelection '],
    'model-setting-all': ['/settings agent.modelSelection ', '<stab>'],
    'model-setting-select': ['/settings agent.modelSelection ', '<stab>', '<down>', '<enter>'],
    'model-setting-esc': ['/settings agent.modelSelection ', '<esc>'],
}

SEED = {
    'model-favs': FAVS,
    'model-favs-all': FAVS,
    'model-unfav': FAVS,
    'model-nicks': NICKS,
    'model-nicks-all': NICKS,
    'model-nick-edit': NICKS,
    'model-nick-edit-save': NICKS,
    'model-nick-delete': NICKS,
    'model-nick-replace': NICKS,
    'model-nick-replace-ok': NICKS,
    'model-failing': FAILING,
}

# OpenRouter's status-bar label names the upstream provider its last request was routed to: `OpenRouter (Anthropic)/…`.
# The base URL is an env-only setting: a settings-file value is dropped when the file is rewritten at launch.
_OPENROUTER = {'settings': {'agent': {'retryAttempts': 0, 'openrouter': {'apiKey': 'test-key'},
                                      'modelSelection': {'model': 'mock-alpha', 'provider': 'openrouter'}}},
               'env': {'OPENROUTER_BASE_URL': '$BASE'}, 'upstream': 'Anthropic', 'ready': 'mock-alpha'}
SCENARIOS['openrouter-upstream'] = ['hello', '<enter>', '<sleep>']
# OpenRouter always reports usage. (With none, next shows `↑0 ↓0` where legacy shows no token figures.)
SEED['openrouter-upstream'] = dict(_OPENROUTER, replies=[{'text': 'routed'}],
                                   usage={'prompt_tokens': 1200, 'completion_tokens': 80})
# Before any request there is no upstream to name.
SCENARIOS['openrouter-idle'] = []
SEED['openrouter-idle'] = dict(_OPENROUTER)
