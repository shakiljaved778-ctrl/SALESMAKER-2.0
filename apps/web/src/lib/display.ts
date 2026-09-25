'use client';

import { PREFERENCE_COOKIES, type Density, type Theme } from './preferences';
import { accessToken } from './session';

const YEAR = 60 * 60 * 24 * 365;

/** Preference cookies are readable by the server so the next page renders without a flash. */
export function writePreferenceCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${String(YEAR)}; SameSite=Lax${secure}`;
}

/** Apply now, remember for the next page, and save to the profile (best effort). */
export function applyDisplay(change: { theme?: Theme; density?: Density }, persist = true): void {
  const root = document.documentElement;
  if (change.theme) {
    root.dataset.theme = change.theme;
    writePreferenceCookie(PREFERENCE_COOKIES.theme, change.theme);
  }
  if (change.density) {
    root.dataset.density = change.density;
    writePreferenceCookie(PREFERENCE_COOKIES.density, change.density);
  }
  const token = accessToken();
  if (persist && token) {
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(change),
    }).catch(() => undefined);
  }
}
