export function getModelListItems(providerType: string | undefined, body: any): any[] {
  if (providerType === 'google') {
    return Array.isArray(body?.models) ? body.models : [];
  }

  return Array.isArray(body?.data) ? body.data : [];
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
