export type ViewerPreset = 'errors' | 'tool_calls' | 'invalid_tool_format' | 'retries';

type ParsedLogRow = {
  level?: string;
  eventType?: string;
  traceId?: string;
  sessionId?: string;
  toolName?: string;
  provider?: string;
  model?: string;
};

export type ViewerRow = {
  raw: string;
  parsed: ParsedLogRow | null;
};

export type ViewerFilters = {
  level?: string;
  text?: string;
  traceId?: string;
  sessionId?: string;
  eventType?: string;
  toolName?: string;
  provider?: string;
  model?: string;
};

export const VIEWER_PRESET_FILTERS: Record<ViewerPreset, ViewerFilters> = {
  errors: { level: 'error' },
  tool_calls: { eventType: 'tool_call.' },
  invalid_tool_format: { eventType: 'tool_call.parse_failed' },
  retries: { eventType: 'retry.' },
};

const includesCaseInsensitive = (source: string, search: string): boolean =>
  source.toLowerCase().includes(search.toLowerCase());

const matchesField = (value: string | undefined, filterValue: string | undefined): boolean => {
  if (!filterValue) return true;
  if (!value) return false;
  if (filterValue.endsWith('.')) {
    return value.startsWith(filterValue);
  }
  return value === filterValue;
};

export const applyViewerFilters = (rows: ViewerRow[], filters: ViewerFilters): ViewerRow[] => {
  const text = filters.text?.trim();
  return rows.filter((row) => {
    const parsed = row.parsed || {};

    if (!matchesField(parsed.level, filters.level)) return false;
    if (!matchesField(parsed.traceId, filters.traceId)) return false;
    if (!matchesField(parsed.sessionId, filters.sessionId)) return false;
    if (!matchesField(parsed.eventType, filters.eventType)) return false;
    if (!matchesField(parsed.toolName, filters.toolName)) return false;
    if (!matchesField(parsed.provider, filters.provider)) return false;
    if (!matchesField(parsed.model, filters.model)) return false;

    if (text) {
      const hay = `${row.raw} ${JSON.stringify(parsed)}`;
      if (!includesCaseInsensitive(hay, text)) return false;
    }
    return true;
  });
};

export const withPreset = (filters: ViewerFilters, preset: ViewerPreset | ''): ViewerFilters => {
  if (!preset) return { ...filters };
  return { ...filters, ...VIEWER_PRESET_FILTERS[preset] };
};
