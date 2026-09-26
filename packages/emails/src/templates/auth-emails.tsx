import { Link } from '@react-email/components';
import { directionOf, serverTranslator } from '@sm/i18n';

import { emailTheme as t } from '../theme.js';
import { CallToAction, Layout, Paragraph } from './layout.js';

export interface VerifyEmailProps {
  locale: string;
  name: string;
  workspace: string;
  url: string;
  expiresInHours: number;
}

export function VerifyEmail({ locale, name, workspace, url, expiresInHours }: VerifyEmailProps) {
  const tr = serverTranslator(locale);
  return (
    <Layout
      lang={locale}
      dir={directionOf(locale)}
      preview={tr('emails.verifyEmail.heading')}
      heading={tr('emails.verifyEmail.heading')}
      footer={tr('emails.footer')}
    >
      <Paragraph>
        {tr('emails.verifyEmail.body', { name, workspace, hours: expiresInHours })}
      </Paragraph>
      <CallToAction href={url} label={tr('emails.verifyEmail.cta')} />
      <Paragraph>{tr('emails.verifyEmail.ignore')}</Paragraph>
    </Layout>
  );
}

export interface ResetPasswordProps {
  locale: string;
  name: string;
  workspace: string;
  url: string;
  expiresInMinutes: number;
}

export function ResetPasswordEmail({
  locale,
  name,
  workspace,
  url,
  expiresInMinutes,
}: ResetPasswordProps) {
  const tr = serverTranslator(locale);
  return (
    <Layout
      lang={locale}
      dir={directionOf(locale)}
      preview={tr('emails.resetPassword.heading')}
      heading={tr('emails.resetPassword.heading')}
      footer={tr('emails.footer')}
    >
      <Paragraph>
        {tr('emails.resetPassword.body', { name, workspace, minutes: expiresInMinutes })}
      </Paragraph>
      <CallToAction href={url} label={tr('emails.resetPassword.cta')} />
      <Paragraph>{tr('emails.resetPassword.ignore')}</Paragraph>
    </Layout>
  );
}

export interface WorkspacesEmailProps {
  locale: string;
  workspaces: { name: string; url: string }[];
}

export function WorkspacesEmail({ locale, workspaces }: WorkspacesEmailProps) {
  const tr = serverTranslator(locale);
  return (
    <Layout
      lang={locale}
      dir={directionOf(locale)}
      preview={tr('emails.workspaces.heading')}
      heading={tr('emails.workspaces.heading')}
      footer={tr('emails.footer')}
    >
      <Paragraph>{tr('emails.workspaces.body', { count: workspaces.length })}</Paragraph>
      {workspaces.map((w) => (
        <Paragraph key={w.url}>
          <Link href={w.url} style={{ color: t.link, fontWeight: 600 }}>
            {w.name}
          </Link>
          {` · ${w.url.replace(/^https?:\/\//, '')}`}
        </Paragraph>
      ))}
    </Layout>
  );
}

export interface InvitationEmailProps {
  locale: string;
  name: string;
  inviter: string;
  workspace: string;
  url: string;
  expiresInDays: number;
}

export function InvitationEmail({
  locale,
  name,
  inviter,
  workspace,
  url,
  expiresInDays,
}: InvitationEmailProps) {
  const tr = serverTranslator(locale);
  return (
    <Layout
      lang={locale}
      dir={directionOf(locale)}
      preview={tr('emails.invitation.heading', { workspace })}
      heading={tr('emails.invitation.heading', { workspace })}
      footer={tr('emails.footer')}
    >
      <Paragraph>
        {tr('emails.invitation.body', { name, inviter, workspace, days: expiresInDays })}
      </Paragraph>
      <CallToAction href={url} label={tr('emails.invitation.cta')} />
      <Paragraph>{tr('emails.invitation.ignore')}</Paragraph>
    </Layout>
  );
}
