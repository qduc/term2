/**
 * Returns the model list carried by a models-listing response body, or null
 * when the body has no recognizable list: `data` for OpenAI-compatible and
 * Anthropic-compatible servers, `models` for Google. A null return lets
 * callers surface an error instead of silently mapping a gateway error body
 * (e.g. HTTP 200 with `{"code":500,"msg":"404 NOT_FOUND"}`) to an empty
 * model catalog.
 */
export function getModelListItems(providerType: string | undefined, body: any): any[] | null {
  if (providerType === 'google') {
    return Array.isArray(body?.models) ? body.models : null;
  }

  return Array.isArray(body?.data) ? body.data : null;
}

export function mapModelListItem(providerType: string | undefined, item: any): { id: string; name?: string } | null {
  if (providerType === 'google') {
    const id = item?.baseModelId || String(item?.name || '').replace(/^models\//, '');
    const name = item?.displayName || item?.description;
    return id ? { id, name } : null;
  }

  const id = item?.id || item?.model || '';
  const name = item?.name || item?.display_name || item?.description;
  return id ? { id, name } : null;
}
