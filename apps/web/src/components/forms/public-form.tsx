'use client';

import { Banner, Button, Checkbox, FormField, Input, Select, Textarea } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { postJson } from '../../lib/client-api';

export interface PublicFormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  maxLength: number | null;
  options: { value: string; label: string }[];
}

export interface PublicFormProps {
  /** Where submissions go (this origin's relay). */
  action: string;
  fields: PublicFormField[];
  buttonLabel: string | null;
  consents: { key: string; text: string; required: boolean }[];
  turnstileSiteKey: string | null;
  theme: 'light' | 'dark' | 'auto';
  /** Attribution from the page address (or the embedding page, via the embed script). */
  context: Record<string, string>;
  /** Inside an embed's iframe: report height and hand redirects to the parent page. */
  embed: boolean;
}

type Value = string | boolean | string[];
type Submitted = { status: 'received'; message: string | null; redirectUrl: string | null };

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
/** API error codes → message keys under forms.errors. */
const ERROR_KEYS = {
  required: 'required',
  invalid_email: 'invalidEmail',
  disposable_email: 'disposableEmail',
  invalid_value: 'invalidValue',
  invalid_number: 'invalidNumber',
  invalid_date: 'invalidDate',
  invalid_url: 'invalidUrl',
  too_long: 'tooLong',
  invalid_type: 'invalidType',
  captcha_failed: 'captchaFailed',
} as const;
const INPUT_TYPES: Record<string, string> = {
  email: 'email',
  phone: 'tel',
  url: 'url',
  number: 'number',
  currency: 'number',
  percent: 'number',
  date: 'date',
};
const AUTOCOMPLETE: Record<string, string> = {
  first_name: 'given-name',
  last_name: 'family-name',
  email: 'email',
  phone: 'tel',
  mobile_phone: 'tel',
  company: 'organization',
  title: 'organization-title',
  website: 'url',
  city: 'address-level2',
  country: 'country-name',
};

/** Tell the embedding page (if any) something; nothing secret is ever sent. */
function toParent(message: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage({ source: 'sm-form', ...message }, '*');
}

/**
 * A hosted web-to-lead form (§7.1, T20): the form's fields from the cell, a honeypot, the
 * optional Turnstile challenge, consents, server errors mapped back onto fields, then the
 * thank-you message or the redirect.
 */
export function PublicForm(props: PublicFormProps) {
  const t = useTranslations('forms');
  const [values, setValues] = useState<Record<string, Value>>({});
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const thanks = useRef<HTMLDivElement>(null);
  const turnstile = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.turnstileSiteKey || document.querySelector(`script[src^="${TURNSTILE_SRC}"]`))
      return;
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }, [props.turnstileSiteKey]);

  // Embedded: keep the iframe as tall as the form.
  useEffect(() => {
    if (!props.embed) return;
    const report = () => {
      toParent({ type: 'height', height: document.documentElement.scrollHeight });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    return () => {
      observer.disconnect();
    };
  }, [props.embed]);

  useEffect(() => {
    if (done !== null) thanks.current?.focus();
  }, [done]);

  const set = (name: string, value: Value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== `fields.${name}`)));
  };
  const message = (code: string) => {
    const key = (ERROR_KEYS as Record<string, (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS]>)[code];
    return key ? t(`errors.${key}`) : t('errors.invalidType');
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const local: Record<string, string> = {};
    for (const f of props.fields) {
      const v = values[f.name];
      const empty = v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);
      if (f.required && empty) local[`fields.${f.name}`] = t('errors.required');
    }
    for (const c of props.consents)
      if (c.required && !consents[c.key]) local[`consents.${c.key}`] = t('errors.required');
    setErrors(local);
    setFormError(Object.keys(local).length ? t('errors.summary') : null);
    if (Object.keys(local).length) return;
    const token = turnstile.current?.querySelector<HTMLInputElement>(
      'input[name="cf-turnstile-response"]',
    )?.value;
    const context = { ...props.context };
    if (!props.embed) {
      context['landingPage'] ??= window.location.href;
      if (document.referrer) context['referrer'] ??= document.referrer;
    }
    setPending(true);
    const result = await postJson<Submitted>(props.action, {
      fields: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')),
      consents,
      ...(honeypot.current?.value ? { website: honeypot.current.value } : {}),
      ...(token ? { turnstileToken: token } : {}),
      context,
    });
    setPending(false);
    if (result.ok) {
      const { redirectUrl } = result.data;
      if (redirectUrl) {
        if (props.embed && window.parent !== window)
          toParent({ type: 'redirect', url: redirectUrl });
        else window.location.assign(redirectUrl);
        return;
      }
      setDone(result.data.message ?? t('thanks'));
      toParent({ type: 'submitted' });
      return;
    }
    if (result.status === 429) {
      setFormError(t('errors.rateLimited'));
      return;
    }
    const fieldErrors: Record<string, string> = {};
    for (const e of result.problem?.errors ?? []) fieldErrors[e.field] ??= message(e.code);
    setErrors(fieldErrors);
    setFormError(
      Object.keys(fieldErrors).length
        ? (fieldErrors['turnstileToken'] ?? t('errors.summary'))
        : t('errors.generic'),
    );
  };

  if (done !== null)
    return (
      <div ref={thanks} tabIndex={-1} role="status" className="text-body text-fg outline-none">
        {done}
      </div>
    );

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {formError ? (
        <Banner tone="danger" role="alert">
          {formError}
        </Banner>
      ) : null}
      {props.fields.map((f) => (
        <FieldControl
          key={f.name}
          field={f}
          value={values[f.name]}
          error={errors[`fields.${f.name}`]}
          onChange={(v) => {
            set(f.name, v);
          }}
          requiredLabel={t('required')}
          placeholder={t('selectPlaceholder')}
        />
      ))}
      {props.consents.map((c) => (
        <div key={c.key} className="flex flex-col gap-1">
          <Checkbox
            label={c.text}
            checked={consents[c.key] ?? false}
            aria-required={c.required}
            aria-invalid={Boolean(errors[`consents.${c.key}`])}
            onCheckedChange={(checked) => {
              setConsents((v) => ({ ...v, [c.key]: checked === true }));
            }}
          />
          {errors[`consents.${c.key}`] ? (
            <p className="text-caption text-danger">{errors[`consents.${c.key}`]}</p>
          ) : null}
        </div>
      ))}
      {/* Honeypot: off-screen, unlabelled for people, never focusable. */}
      <div
        aria-hidden="true"
        className="absolute -start-[10000px] top-auto size-px overflow-hidden"
      >
        <input ref={honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {props.turnstileSiteKey ? (
        <div
          ref={turnstile}
          className="cf-turnstile"
          aria-label={t('turnstileLabel')}
          data-sitekey={props.turnstileSiteKey}
          data-theme={props.theme}
        />
      ) : null}
      <Button type="submit" variant="primary" loading={pending} loadingLabel={t('sending')}>
        {props.buttonLabel ?? t('submit')}
      </Button>
    </form>
  );
}

function FieldControl({
  field,
  value,
  error,
  onChange,
  requiredLabel,
  placeholder,
}: {
  field: PublicFormField;
  value: Value | undefined;
  error: string | undefined;
  onChange: (value: Value) => void;
  requiredLabel: string;
  placeholder: string;
}) {
  if (field.type === 'checkbox')
    return (
      <div className="flex flex-col gap-1">
        <Checkbox
          label={field.label}
          checked={value === true}
          aria-required={field.required}
          aria-invalid={Boolean(error)}
          onCheckedChange={(checked) => {
            onChange(checked === true);
          }}
        />
        {error ? <p className="text-caption text-danger">{error}</p> : null}
      </div>
    );
  if (field.type === 'multi_picklist') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="flex flex-col gap-2" aria-invalid={Boolean(error)}>
        <legend className="mb-1 text-label text-fg">
          {field.label}
          {field.required ? (
            <span className="ms-0.5 text-danger" aria-label={requiredLabel}>
              *
            </span>
          ) : null}
        </legend>
        {field.options.map((o) => (
          <Checkbox
            key={o.value}
            label={o.label}
            checked={chosen.includes(o.value)}
            onCheckedChange={(checked) => {
              onChange(
                checked === true ? [...chosen, o.value] : chosen.filter((v) => v !== o.value),
              );
            }}
          />
        ))}
        {error ? <p className="text-caption text-danger">{error}</p> : null}
      </fieldset>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <FormField
      label={field.label}
      required={field.required}
      requiredLabel={requiredLabel}
      error={error}
    >
      {field.type === 'picklist' ? (
        <Select
          options={field.options}
          value={text || undefined}
          placeholder={placeholder}
          onValueChange={onChange}
        />
      ) : field.type === 'textarea' || field.type === 'long_text' ? (
        <Textarea
          value={text}
          maxLength={field.maxLength ?? undefined}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <Input
          type={INPUT_TYPES[field.type] ?? 'text'}
          value={text}
          maxLength={field.maxLength ?? undefined}
          autoComplete={AUTOCOMPLETE[field.name] ?? 'on'}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}
    </FormField>
  );
}
