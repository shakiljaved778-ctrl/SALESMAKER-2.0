/**
 * Disposable-email domains refused on web forms (§7.1). A short hand-made list of the widely used
 * services (the maintained public list is CC0, outside the licences §0.3 allows without the
 * owner's OK); each form adds its own in `settings.blockedDomains`.
 */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '20minutemail.com',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'maildrop.cc',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'mytemp.email',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmail.net',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.de',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
]);

/** Whether an address's domain (or a parent domain) is refused. */
export function isBlockedEmail(email: string, extra: readonly string[] = []): boolean {
  const domain = email.split('@').pop()?.trim().toLowerCase() ?? '';
  const blocked = (d: string) => DISPOSABLE_DOMAINS.has(d) || extra.includes(d);
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) if (blocked(parts.slice(i).join('.'))) return true;
  return false;
}
