// This is a term2-only client: agent mode is on unless explicitly disabled.
export function isTerm2UiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TERM2_UI_ENABLED !== 'false';
}

export function isTerm2LocalControlEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TERM2_LOCAL_CONTROL_ENABLED === 'true';
}
