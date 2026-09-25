import { createHmac } from 'node:crypto';

/** Canonical form of an email for routing: Unicode NFKC, trimmed, lower-cased. */
export function normaliseEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

/**
 * Keyed hash used by the control plane to route logins without ever storing the address
 * (spec v1.2, §3.4). The pepper is shared by the control plane and every cell, is distinct per
 * environment, and lives in Secrets Manager.
 */
export function emailRoutingHmac(email: string, pepper: string): Buffer {
  if (pepper.length < 16) throw new Error('EMAIL_ROUTING_PEPPER must be at least 16 characters');
  return createHmac('sha256', pepper).update(normaliseEmail(email), 'utf8').digest();
}
