export function getModelListItems(providerType: string | undefined, body: any): any[] {
  if (providerType === 'google') {
    return Array.isArray(body?.models) ? body.models : [];
  }

  return Array.isArray(body?.data) ? body.data : [];
}

export function mapModelListItem(providerType: string | undefined, item: any): { id: string; name?: string } | null {
  // Output capabilities describe generation, not vision/video input support.
  const outputs = item?.architecture?.output_modalities;
  if (Array.isArray(outputs) && (outputs.length !== 1 || outputs[0] !== 'text')) {
    return null;
  }

  // OrcaRouter advertises endpoint types even for non-chat models. When this
  // metadata exists, only list models served by the configured wire protocol.
  // Null/empty endpoint lists do not advertise a usable endpoint. Providers
  // returning the minimal OpenAI model schema remain supported.
  const endpointType = providerType === 'anthropic' ? 'anthropic' : providerType === 'google' ? 'gemini' : 'openai';
  if (
    providerType !== 'opencode' &&
    item &&
    typeof item === 'object' &&
    'supported_endpoint_types' in item &&
    (!Array.isArray(item.supported_endpoint_types) || !item.supported_endpoint_types.includes(endpointType))
  ) {
    return null;
  }

  if (providerType === 'google') {
    const id = item?.baseModelId || String(item?.name || '').replace(/^models\//, '');
    const name = item?.displayName || item?.description;
    return id ? { id, name } : null;
  }

  const id = item?.id || item?.model || '';
  const name = item?.name || item?.display_name || item?.description;
  return id ? { id, name } : null;
}
