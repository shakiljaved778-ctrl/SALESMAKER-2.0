'use client';

import { Dialog, Kbd } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { ALL_NAV } from './nav';

/** The `?` sheet (§9.11): every shortcut available in this release. */
export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setMod('⌘');
  }, []);

  const global: [string, string[]][] = [
    [t('shortcuts.palette'), [mod, 'K']],
    [t('shortcuts.assistant'), [mod, 'J']],
    [t('shortcuts.sidebar'), ['[']],
    [t('shortcuts.help'), ['?']],
  ];
  const goTo = ALL_NAV.filter((n) => n.go);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('shortcuts.title')}
      closeLabel={tc('actions.close')}
      size="sm"
    >
      <section className="flex flex-col gap-2">
        <h3 className="text-label text-fg-secondary">{t('shortcuts.global')}</h3>
        <dl className="flex flex-col">
          {global.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-body-sm text-fg">{label}</dt>
              <dd className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="mt-4 flex flex-col gap-2">
        <h3 className="text-label text-fg-secondary">{t('shortcuts.goTo')}</h3>
        <dl className="flex flex-col">
          {goTo.map((n) => (
            <div key={n.key} className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-body-sm text-fg">{t(`nav.${n.key}`)}</dt>
              <dd className="flex items-center gap-1 text-caption text-fg-secondary">
                <Kbd>G</Kbd>
                {t('shortcuts.then')}
                <Kbd>{(n.go ?? '').toUpperCase()}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </Dialog>
  );
}
