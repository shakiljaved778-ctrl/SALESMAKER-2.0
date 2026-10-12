import type { Readable } from 'node:stream';

import { parseEmail, type StorageProvider } from '@sm/integrations';
import { captureLead, loadRecordContext, scoreRecords } from '@sm/records';
import { sql } from 'kysely';

import type { InTenant } from './run.js';

/*
 * Email-to-lead processing (§7.1, P03 T21), on the worker. The API has stored the raw message and
 * an `inbound_email` row; here the message is parsed and either stored on the lead or contact the
 * sender already is (MATCHED; activities replace this in P04) or turned into a new lead through
 * the capture pipeline as the address's run-as user (CREATED, MATCHED when a Block duplicate rule
 * links it to an existing lead, FAILED when refused). Signature parsing is AI work (P07).
 */

/** Payload `{ emailId }`. */
export const INBOUND_EMAIL_TOPIC = 'email-sync.inbound_lead';

/** Mailbox providers whose domain says nothing about the sender's company. */
const FREEMAIL = new Set([
  'aol.com',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'yandex.com',
  'zoho.com',
]);
/** Second-level labels of country domains (acme.co.uk → acme). */
const GENERIC = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A company name from a business domain (`sales@acme-group.co.uk` → `Acme-group`); null for mailboxes. */
export function companyFromDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  if (FREEMAIL.has(d)) return null;
  const labels = d.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  let label = labels[labels.length - 2] ?? '';
  if (GENERIC.has(label) && labels.length >= 3) label = labels[labels.length - 3] ?? label;
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : null;
}

/** The lead an email describes: the sender's name and address, company, subject and text. */
export function leadFromEmail(
  from: { address: string; name: string | null },
  subject: string | null,
  text: string,
): Record<string, unknown> {
  const [local = '', domain = ''] = from.address.split('@');
  const parts = (from.name ?? '').split(/\s+/).filter(Boolean);
  const last = parts.length ? (parts.at(-1) ?? local) : local;
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined;
  const description = [subject, text].filter(Boolean).join('\n\n').slice(0, 30_000);
  return {
    ...(first ? { first_name: first.slice(0, 80) } : {}),
    last_name: last.slice(0, 80),
    email: from.address,
    ...(companyFromDomain(domain) ? { company: companyFromDomain(domain) } : {}),
    ...(description ? { description } : {}),
  };
}

export async function processInboundEmail(
  deps: { inTenant: InTenant; storage: StorageProvider },
  emailId: string,
): Promise<void> {
  const email = await deps.inTenant((tx) =>
    tx.prisma.inboundEmail.findFirst({ where: { id: emailId }, include: { address: true } }),
  );
  if (email?.status !== 'RECEIVED') return;
  const parsed = await parseEmail(await bytes(await deps.storage.getObject(email.rawKey)));
  await deps.inTenant(async (tx) => {
    const tenantId = tx.context.tenantId;
    // Claim the row: a redelivered job finds it no longer RECEIVED.
    const claimed = await sql<{ id: string }>`SELECT id FROM inbound_email
      WHERE tenant_id = ${tenantId}::uuid AND id = ${emailId}::uuid AND status = 'RECEIVED'
      FOR UPDATE SKIP LOCKED`.execute(tx.kysely);
    if (claimed.rows.length === 0) return;
    const finish = (data: {
      status: 'CREATED' | 'MATCHED' | 'REJECTED' | 'FAILED';
      recordObject?: string | null;
      recordId?: string | null;
      reason?: string | null;
    }) =>
      tx.prisma.inboundEmail.update({
        where: { tenantId_id: { tenantId, id: emailId } },
        data,
      });
    const sender = parsed.from;
    if (!sender) {
      await finish({ status: 'REJECTED', reason: 'no_sender' });
      return;
    }
    const address = email.address;
    // A known sender: the email is stored on their lead (open ones first) or contact.
    const known = (
      await sql<{ object: string; id: string }>`
        (SELECT 'lead' AS object, id, created_at FROM lead
          WHERE tenant_id = ${tenantId}::uuid AND lower(email) = ${sender.address}
            AND deleted_at IS NULL AND converted_at IS NULL
          ORDER BY created_at LIMIT 1)
        UNION ALL
        (SELECT 'contact', id, created_at FROM contact
          WHERE tenant_id = ${tenantId}::uuid AND lower(email) = ${sender.address}
            AND deleted_at IS NULL
          ORDER BY created_at LIMIT 1)`.execute(tx.kysely)
    ).rows[0];
    if (known) {
      await finish({ status: 'MATCHED', recordObject: known.object, recordId: known.id });
      if (known.object === 'lead') {
        const ctx = await loadRecordContext(tx, address.runAsUserId);
        await scoreRecords(tx, { metadata: ctx.metadata, timezone: ctx.timezone }, 'lead', [
          known.id,
        ]);
      }
      return;
    }
    const fields = leadFromEmail(sender, parsed.subject, parsed.text);
    const defaults = address.defaults as Record<string, unknown>;
    // No company from the domain or the address's defaults: the sender stands in for one.
    if (fields['company'] === undefined && !defaults['company'])
      fields['company'] = (sender.name ?? sender.address).slice(0, 255);
    await captureLead(
      tx,
      {
        runAsUserId: address.runAsUserId,
        fields,
        defaults,
        source: { capturedVia: 'email', detail: address.name },
        assignmentRuleId: address.assignmentRuleId,
      },
      async (r) => {
        await finish({
          status:
            r.status === 'CREATED' ? 'CREATED' : r.status === 'DUPLICATE' ? 'MATCHED' : 'FAILED',
          recordObject: r.recordId ? 'lead' : null,
          recordId: r.recordId,
          reason: r.errors.length
            ? r.errors
                .map((e) => `${e.field}:${e.code}`)
                .join(', ')
                .slice(0, 1000)
            : null,
        });
      },
    );
  });
}
