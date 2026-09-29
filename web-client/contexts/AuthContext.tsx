'use client';

import { createContext, useContext } from 'react';

/**
 * ChatForge auth replacement for the salvaged agent slice.
 *
 * The imported slice read its viewer from ChatForge's `AuthContext`
 * (`useAuth()`), which ran the product's login/registration flow against
 * ChatForge's auth API. This client has no login flow: the thin server owns
 * identity and injects the gateway assertion subject, so the browser only needs
 * a stable viewer id to namespace its own state. See
 * `docs/plans/web-client-composable-redesign.md` ("ChatForge salvage boundary"
 * — *Replace: ChatForge auth ... with a minimal single local-owner identity*).
 *
 * The module keeps the slice's import path (`contexts/AuthContext`) so no
 * imported component needed an import-path edit, and keeps the `useAuth()`
 * shape so a later task can swap in a real identity source. There is no token
 * storage, no provider requirement, and no product surface behind it.
 */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

/** The single local-owner viewer of this client. */
export const LOCAL_OWNER_USER: AuthUser = {
  id: 'local-owner',
  email: 'local-owner@localhost',
  displayName: 'Local owner',
};

export interface AuthContextValue {
  user: AuthUser | null;
}

const AuthContext = createContext<AuthContextValue>({ user: LOCAL_OWNER_USER });

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
