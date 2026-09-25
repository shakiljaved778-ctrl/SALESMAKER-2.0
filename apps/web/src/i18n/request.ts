import { messagesFor } from '@sm/i18n';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { readPreferences } from '../lib/preferences';

/**
 * next-intl without locale routing: a workspace lives on its own host, so the locale comes from
 * the user's preference cookie (then their profile, from P01), never from the URL.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const { locale } = readPreferences((name) => store.get(name)?.value);
  return { locale, messages: messagesFor(locale) };
});
