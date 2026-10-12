import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  PublicWebFormDto,
  SubmitWebFormRequest,
  SubmitWebFormResponse,
  WebFormDto,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import type { CaptchaVerifier, EmailSender } from '@sm/integrations';
import type { FieldMeta, ObjectMeta } from '@sm/metadata';
import { captureLead, type CaptureResult } from '@sm/records';
import { DomainError, errors, type TokenBucketRateLimiter } from '@sm/server-kit';
import type { Logger } from 'pino';
import type { z } from 'zod';

import type { ApiConfig } from '../config.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { CAPTCHA, CONFIG, EMAIL_SENDER, LOGGER, PRISMA, RATE_LIMITER } from '../tokens.js';
import { isBlockedEmail } from './disposable-domains.js';
import { VISITOR_TYPES } from './web-forms-setup.service.js';

type Settings = z.infer<typeof WebFormDto>['settings'];
type Submit = z.output<typeof SubmitWebFormRequest>;
type Problem = { field: string; code: string; message: string };
type Value = Submit['fields'][string];

interface ActiveForm {
  id: string;
  name: string;
  runAsUserId: string;
  settings: Settings;
  defaults: Record<string, unknown>;
  assignmentRuleId: string | null;
  autoResponder: { subject: string; body: string } | null;
  fields: {
    field: string;
    label: string | null;
    required: boolean;
    hidden: boolean;
    defaultValue: unknown;
    values: string[];
  }[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/**
 * Public web-to-lead (§7.1, §3.5): unauthenticated, so every step is defensive. The tenant and an
 * ACTIVE form must exist in this cell (else 404); a per-IP bucket per form limits floods; the
 * honeypot and Turnstile stop bots; values are checked against the form before anything is
 * stored. A valid submission is committed first, then the lead is created as the form's run-as
 * user in a second transaction, so a rule refusing it never loses the submission.
 */
@Injectable()
export class PublicFormsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(RATE_LIMITER) private readonly limiter: TokenBucketRateLimiter,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(CAPTCHA) private readonly captcha: CaptchaVerifier | null,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly metadata: MetadataService,
  ) {}

  /** The tenant's ACTIVE form and the lead object; 404 for anything else (nothing leaks). */
  private async load(
    tx: TenantTransaction,
    formId: string,
  ): Promise<{ form: ActiveForm; lead: ObjectMeta }> {
    const settings = await tx.prisma.tenantSettings.findUnique({
      where: { tenantId: tx.context.tenantId },
      select: { tenantId: true },
    });
    const row = settings
      ? await tx.prisma.webForm.findFirst({
          where: { id: formId, status: 'ACTIVE' },
          include: { fields: { orderBy: { sortOrder: 'asc' } } },
        })
      : null;
    if (!row) throw errors.notFound('Form');
    const lead = (await this.metadata.forTenant(tx)).object('lead');
    if (!lead) throw errors.notFound('Form');
    return {
      form: {
        id: row.id,
        name: row.name,
        runAsUserId: row.runAsUserId,
        settings: row.settings as Settings,
        defaults: row.defaults as Record<string, unknown>,
        assignmentRuleId: row.assignmentRuleId,
        autoResponder: row.autoResponder as ActiveForm['autoResponder'],
        fields: row.fields,
      },
      lead,
    };
  }

  /** What a visible field offers: its own subset, else every active value. */
  private options(f: FieldMeta, subset: readonly string[], t: (key: string) => string) {
    if (f.type !== 'picklist' && f.type !== 'multi_picklist') return [];
    return f.picklistValues
      .filter((v) => v.active && (subset.length === 0 || subset.includes(v.apiValue)))
      .map((v) => ({
        value: v.apiValue,
        label: v.label ?? (v.labelKey ? t(v.labelKey) : v.apiValue),
      }));
  }

  /** The form as a page renders it: visible fields only, hidden ones never leave the server. */
  async describe(
    tenantId: string,
    formId: string,
    locale: string,
  ): Promise<z.infer<typeof PublicWebFormDto>> {
    const t = serverTranslator(locale) as unknown as (key: string) => string;
    return withTenant(this.prisma, { tenantId }, async (tx) => {
      const { form, lead } = await this.load(tx, formId);
      return {
        id: form.id,
        name: form.name,
        fields: form.fields.flatMap((ff) => {
          const f = lead.fields.find((x) => x.apiName === ff.field);
          if (ff.hidden || !f || !VISITOR_TYPES.has(f.type)) return [];
          return [
            {
              name: f.apiName,
              label: ff.label ?? f.label ?? (f.labelKey ? t(f.labelKey) : f.apiName),
              type: f.type,
              required: ff.required,
              maxLength: f.length,
              options: this.options(f, ff.values, t),
            },
          ];
        }),
        theme: form.settings.theme,
        buttonLabel: form.settings.buttonLabel,
        consents: form.settings.consents,
        turnstileSiteKey: form.settings.turnstile ? (this.captcha?.siteKey ?? null) : null,
      };
    });
  }

  /** A keyed hash of the IP: enough to rate-limit and spot floods, never the address itself. */
  private ipHash(ip: string): string {
    return createHmac('sha256', this.config.SECRETS_KEY)
      .update(`web-form-ip:${ip}`)
      .digest('hex')
      .slice(0, 32);
  }

  private async rateLimit(formId: string, ipHash: string): Promise<void> {
    const result = await this.limiter
      .consume(`form:${formId}:${ipHash}`, {
        capacity: this.config.FORM_RATE_BURST,
        refillPerSecond: this.config.FORM_RATE_PER_HOUR / 3600,
      })
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'rate limiter unavailable; allowing form submission');
        return { allowed: true, resetSeconds: 0 };
      });
    if (!result.allowed)
      throw new DomainError(
        'rate_limited',
        429,
        'Too many submissions from this network. Try again later.',
        undefined,
        { 'retry-after': String(Math.max(1, result.resetSeconds)) },
      );
  }

  /** One visitor value against its field; the value as the lead takes it, or a problem. */
  private value(
    f: FieldMeta,
    raw: Value,
    allowed: ReadonlySet<string>,
  ): { value: unknown } | { code: string; message: string } {
    const max = f.length ?? (f.type === 'long_text' || f.type === 'textarea' ? 32_000 : 255);
    const text = typeof raw === 'string' ? raw.trim() : null;
    switch (f.type) {
      case 'checkbox':
        return typeof raw === 'boolean'
          ? { value: raw }
          : { code: 'invalid_type', message: 'Expected true or false' };
      case 'multi_picklist':
        return Array.isArray(raw) && raw.every((v) => allowed.has(v))
          ? { value: raw }
          : { code: 'invalid_value', message: 'Not one of the choices' };
      case 'picklist':
        return text !== null && allowed.has(text)
          ? { value: text }
          : { code: 'invalid_value', message: 'Not one of the choices' };
      case 'number':
      case 'currency':
      case 'percent': {
        const n = typeof raw === 'number' ? String(raw) : text;
        return n !== null && NUMBER.test(n)
          ? { value: n }
          : { code: 'invalid_number', message: 'Enter a number' };
      }
      case 'date':
        return text !== null && DATE.test(text) && !Number.isNaN(Date.parse(text))
          ? { value: text }
          : { code: 'invalid_date', message: 'Enter a date (YYYY-MM-DD)' };
      default:
        break;
    }
    if (text === null) return { code: 'invalid_type', message: 'Expected text' };
    if (text.length > max)
      return { code: 'too_long', message: `At most ${String(max)} characters` };
    if (f.type === 'email' && !EMAIL.test(text))
      return { code: 'invalid_email', message: 'Enter an email address' };
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(text))
      return { code: 'invalid_url', message: 'Enter a web address' };
    return { value: text };
  }

  /** The visitor's values checked against the form: 400 with every problem at once. */
  private validate(form: ActiveForm, lead: ObjectMeta, body: Submit): Record<string, unknown> {
    const problems: Problem[] = [];
    const out: Record<string, unknown> = {};
    const visible = new Map(form.fields.filter((f) => !f.hidden).map((f) => [f.field, f]));
    for (const key of Object.keys(body.fields))
      if (!visible.has(key))
        problems.push({
          field: `fields.${key}`,
          code: 'unknown_field',
          message: 'Not on this form',
        });
    for (const ff of visible.values()) {
      const f = lead.fields.find((x) => x.apiName === ff.field);
      if (!f) continue;
      const raw = body.fields[ff.field];
      const at = `fields.${ff.field}`;
      if (blank(raw) || raw === false) {
        if (ff.required)
          problems.push({ field: at, code: 'required', message: 'This field is required' });
        if (raw === false) out[ff.field] = false;
        continue;
      }
      const allowed = new Set(
        f.picklistValues
          .filter((v) => v.active && (ff.values.length === 0 || ff.values.includes(v.apiValue)))
          .map((v) => v.apiValue),
      );
      const checked = this.value(f, raw ?? null, allowed);
      if ('code' in checked) {
        problems.push({ field: at, code: checked.code, message: checked.message });
        continue;
      }
      if (f.type === 'email' && isBlockedEmail(String(checked.value), form.settings.blockedDomains))
        problems.push({
          field: at,
          code: 'disposable_email',
          message: 'Use a permanent email address',
        });
      out[ff.field] = checked.value;
    }
    for (const c of form.settings.consents)
      if (c.required && body.consents[c.key] !== true)
        problems.push({
          field: `consents.${c.key}`,
          code: 'required',
          message: 'This consent is required',
        });
    if (problems.length) throw errors.validation(problems);
    return out;
  }

  async submit(
    tenantId: string,
    formId: string,
    body: Submit,
    client: { ip: string; userAgent?: string | undefined },
  ): Promise<z.infer<typeof SubmitWebFormResponse>> {
    const { form, lead } = await withTenant(this.prisma, { tenantId }, (tx) =>
      this.load(tx, formId),
    );
    const ipHash = this.ipHash(client.ip);
    await this.rateLimit(form.id, ipHash);
    const accepted = {
      status: 'received' as const,
      message: form.settings.thankYouMessage,
      redirectUrl: form.settings.redirectUrl,
    };
    const ctx = body.context;
    const meta = Object.fromEntries(
      Object.entries({
        utm_source: ctx.utmSource,
        utm_medium: ctx.utmMedium,
        utm_campaign: ctx.utmCampaign,
        utm_term: ctx.utmTerm,
        utm_content: ctx.utmContent,
        referrer: ctx.referrer,
        landing_page: ctx.landingPage,
        gclid: ctx.gclid,
        fbclid: ctx.fbclid,
        ipHash,
        userAgent: client.userAgent?.slice(0, 500),
      }).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
    );
    const store = (status: 'RECEIVED' | 'REJECTED', payload: object, reason: string | null) =>
      withTenant(this.prisma, { tenantId }, (tx) =>
        tx.prisma.webFormSubmission.create({
          data: { tenantId, formId: form.id, status, payload, meta, reason },
          select: { id: true },
        }),
      );

    // A filled honeypot is a bot: kept for the record, answered like any submission.
    if (body.website) {
      await store('REJECTED', {}, 'honeypot');
      return accepted;
    }
    if (form.settings.turnstile) {
      const ok =
        this.captcha !== null && (await this.captcha.verify(body.turnstileToken ?? '', client.ip));
      if (!ok)
        throw errors.validation([
          {
            field: 'turnstileToken',
            code: 'captcha_failed',
            message: 'Please try the check again',
          },
        ]);
    }
    const fields = this.validate(form, lead, body);
    const submission = await store('RECEIVED', { fields, consents: body.consents }, null);

    // Hidden fields always apply; the form's defaults fill what is left empty.
    const hidden = Object.fromEntries(
      form.fields.filter((f) => f.hidden).map((f) => [f.field, f.defaultValue]),
    );
    let result: CaptureResult;
    try {
      result = await withTenant(
        this.prisma,
        { tenantId, userId: form.runAsUserId },
        (tx) =>
          captureLead(
            tx,
            {
              runAsUserId: form.runAsUserId,
              fields: { ...fields, ...hidden },
              defaults: form.defaults,
              source: {
                capturedVia: 'web_form',
                detail: form.name,
                utm: {
                  source: ctx.utmSource,
                  medium: ctx.utmMedium,
                  campaign: ctx.utmCampaign,
                  term: ctx.utmTerm,
                  content: ctx.utmContent,
                },
                ...(ctx.referrer ? { referrer: ctx.referrer } : {}),
                ...(ctx.landingPage ? { landingPage: ctx.landingPage } : {}),
                ...(ctx.gclid ? { gclid: ctx.gclid } : {}),
                ...(ctx.fbclid ? { fbclid: ctx.fbclid } : {}),
              },
              assignmentRuleId: form.assignmentRuleId,
            },
            async (r) => {
              await tx.prisma.webFormSubmission.update({
                where: { tenantId_id: { tenantId, id: submission.id } },
                data: {
                  status: r.status,
                  recordId: r.recordId,
                  reason: r.errors.length
                    ? r.errors
                        .map((e) => `${e.field}:${e.code}`)
                        .join(', ')
                        .slice(0, 1000)
                    : null,
                },
              });
            },
          ),
        { timeoutMs: 30_000 },
      );
    } catch (err) {
      // The submission is safe; an admin sees it as FAILED and the visitor is not blamed.
      this.logger.error(
        { err, formId: form.id, submissionId: submission.id },
        'web form capture failed',
      );
      await withTenant(this.prisma, { tenantId }, (tx) =>
        tx.prisma.webFormSubmission.update({
          where: { tenantId_id: { tenantId, id: submission.id } },
          data: { status: 'FAILED', reason: 'internal_error' },
        }),
      ).catch(() => undefined);
      return accepted;
    }
    if (result.status !== 'FAILED') await this.autoRespond(form, lead, fields, submission.id);
    return accepted;
  }

  /** The form's auto-responder to the visitor's email (after commit; failures only logged). */
  private async autoRespond(
    form: ActiveForm,
    lead: ObjectMeta,
    fields: Record<string, unknown>,
    submissionId: string,
  ): Promise<void> {
    if (!form.autoResponder) return;
    const emailField = form.fields.find(
      (ff) => !ff.hidden && lead.fields.find((f) => f.apiName === ff.field)?.type === 'email',
    );
    const to = emailField ? fields[emailField.field] : undefined;
    if (typeof to !== 'string') return;
    const fill = (s: string) =>
      s.replace(/\{(first_name|last_name)\}/g, (_, k: string) => {
        const v = fields[k];
        return typeof v === 'string' ? v : '';
      });
    const text = fill(form.autoResponder.body);
    try {
      await this.sender.send({
        to,
        subject: fill(form.autoResponder.subject).replace(/[\r\n]+/g, ' '),
        text,
        html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
        idempotencyKey: `web-form-autoresponse:${submissionId}`,
        tags: { kind: 'web_form_autoresponse' },
      });
    } catch (err) {
      this.logger.warn({ err, formId: form.id }, 'web form auto-responder failed');
    }
  }
}
