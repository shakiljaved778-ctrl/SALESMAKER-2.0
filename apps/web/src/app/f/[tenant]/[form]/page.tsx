import { directionOf, isLocale, messagesFor } from '@sm/i18n';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';

import { PublicForm } from '../../../../components/forms/public-form';
import { SystemPage } from '../../../../components/system-page';
import { readPreferences } from '../../../../lib/preferences';
import { bffDeps } from '../../../../server/deps';
import { loadPublicForm } from '../../../../server/forms';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ tenant: string; form: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Page-address parameters carried into the submission's attribution (§7.1). */
const CONTEXT_PARAMS: Record<string, string> = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_term: 'utmTerm',
  utm_content: 'utmContent',
  gclid: 'gclid',
  fbclid: 'fbclid',
  // Set by the embed script: the embedding page and its referrer.
  landing: 'landingPage',
  referrer: 'referrer',
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The visitor's locale: `?locale=` when it is one of ours, else their preference cookie. */
async function localeFor(query: Record<string, string | string[] | undefined>) {
  const asked = first(query['locale']);
  if (isLocale(asked)) return asked;
  const store = await cookies();
  return readPreferences((name) => store.get(name)?.value).locale;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenant, form } = await params;
  const loaded = await loadPublicForm(bffDeps(), tenant, form, 'en');
  return {
    title: loaded.kind === 'ok' ? loaded.form.name : undefined,
    robots: { index: false },
  };
}

/**
 * A hosted web-to-lead form (§7.1, P03 T20): `/f/{slug}/{formId}`, standalone or inside the embed
 * script's iframe (`?embed=1`). It carries the form's own theme (light, dark or the visitor's
 * system setting) whatever the visitor's app preference.
 */
export default async function HostedFormPage({ params, searchParams }: Props) {
  const [{ tenant, form: formId }, query] = await Promise.all([params, searchParams]);
  const locale = await localeFor(query);
  const loaded = await loadPublicForm(bffDeps(), tenant, formId, locale);
  if (loaded.kind === 'not_found') notFound();
  const t = await getTranslations({ locale, namespace: 'forms' });
  if (loaded.kind === 'unavailable')
    return <SystemPage title={t('unavailable.title')} body={t('unavailable.body')} />;
  const { form } = loaded;
  const embed = first(query['embed']) === '1';
  const context = Object.fromEntries(
    Object.entries(CONTEXT_PARAMS).flatMap(([param, key]) => {
      const v = first(query[param])?.slice(0, 2000);
      return v ? [[key, v]] : [];
    }),
  );
  return (
    <div
      data-theme-scope={form.theme === 'auto' ? 'system' : form.theme}
      lang={locale}
      dir={directionOf(locale)}
      className={embed ? 'bg-canvas p-4 text-fg' : 'min-h-dvh bg-canvas px-4 py-10 text-fg'}
    >
      <main className="mx-auto flex w-full max-w-lg flex-col gap-6 rounded-lg bg-surface p-6 shadow-e-1">
        <h1 className="text-title-2 text-fg">{form.name}</h1>
        <NextIntlClientProvider locale={locale} messages={messagesFor(locale)}>
          <PublicForm
            action={`/api/forms/${tenant}/${form.id}`}
            fields={form.fields}
            buttonLabel={form.buttonLabel}
            consents={form.consents}
            turnstileSiteKey={form.turnstileSiteKey}
            theme={form.theme}
            context={context}
            embed={embed}
          />
        </NextIntlClientProvider>
      </main>
    </div>
  );
}
