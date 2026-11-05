/** The setting that stores each API-key credential, keyed by provider id. Read by the account commands and the server's settings projection. */
export const CREDENTIAL_SETTINGS: Readonly<
  Record<string, { readonly settingKey: string; readonly required: boolean }>
> = {
  openai: { settingKey: 'agent.openai.apiKey', required: true },
  openrouter: { settingKey: 'agent.openrouter.apiKey', required: true },
  tavily: { settingKey: 'webSearch.tavily.apiKey', required: true },
  exa: { settingKey: 'webSearch.exa.apiKey', required: true },
  firecrawl: { settingKey: 'webSearch.firecrawl.apiKey', required: true },
};
