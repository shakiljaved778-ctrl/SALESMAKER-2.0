'use client';

import type { MeResponse } from '@sm/contracts';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { postJson } from './client-api';

export type Me = z.infer<typeof MeResponse>;

interface Session {
  accessToken: string;
  accessTokenExpiresAt: string;
  user?: Me;
}

/** The access token lives only in this module's memory; the refresh token is an httpOnly cookie. */
let current: Session | undefined;

export function rememberSession(session: Session): void {
  current = session;
}

export function accessToken(): string | undefined {
  return current?.accessToken;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; session: Session & { user: Me } }
  | { status: 'signed-out' }
  | { status: 'unavailable' };

let inFlight: Promise<Awaited<ReturnType<typeof postJson<Session>>>> | undefined;

/**
 * Rotate the refresh cookie. Refresh tokens are single-use with reuse detection, so two refreshes
 * racing with the same cookie would end the session: calls are shared within the page, and
 * serialised across tabs with a Web Lock so each request carries the latest cookie.
 */
export function refreshSession() {
  inFlight ??= (async () => {
    try {
      const run = () => postJson<Session>('/api/auth/refresh', {});
      return 'locks' in navigator
        ? await navigator.locks.request('sm-session-refresh', run)
        : await run();
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

/** Restore the session on page load by rotating the refresh cookie once. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(() =>
    current?.user
      ? { status: 'signed-in', session: { ...current, user: current.user } }
      : { status: 'loading' },
  );
  useEffect(() => {
    if (state.status !== 'loading') return;
    let cancelled = false;
    void refreshSession().then((result) => {
      if (cancelled) return;
      if (result.ok && result.data.user) {
        current = result.data;
        setState({ status: 'signed-in', session: { ...result.data, user: result.data.user } });
      } else if (!result.ok && (result.status === 401 || result.status === 404)) {
        setState({ status: 'signed-out' });
      } else {
        setState({ status: 'unavailable' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state.status]);
  return state;
}

export async function signOut(): Promise<void> {
  current = undefined;
  await postJson('/api/auth/logout', {});
}
