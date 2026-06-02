const OPENCODE_HOST_FRAGMENT = 'opencode.ai';

export type OpencodeProviderIdentity = {
  type?: string;
  name?: string;
  baseUrl?: string;
};

export function isOpencodeProvider(identity: OpencodeProviderIdentity): boolean {
  return (
    identity.type === 'opencode' ||
    identity.name === 'opencode' ||
    (typeof identity.baseUrl === 'string' && identity.baseUrl.toLowerCase().includes(OPENCODE_HOST_FRAGMENT))
  );
}

export function resolveOpencodeRuntimeConfig(
  baseUrl?: string,
  apiKey?: string,
): {
  baseUrl: string;
  apiKey: string | undefined;
} {
  return {
    baseUrl: baseUrl ?? 'https://opencode.ai/v1',
    apiKey: apiKey ?? process.env.OPENCODE_API_KEY,
  };
}
