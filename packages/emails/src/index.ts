import { render } from '@react-email/render';
import { serverTranslator } from '@sm/i18n';
import { createElement } from 'react';

import {
  InvitationEmail,
  ResetPasswordEmail,
  VerifyEmail,
  WorkspacesEmail,
  type InvitationEmailProps,
  type ResetPasswordProps,
  type VerifyEmailProps,
  type WorkspacesEmailProps,
} from './templates/auth-emails.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

async function both(
  element: ReturnType<typeof createElement>,
): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}

export async function renderVerifyEmail(props: VerifyEmailProps): Promise<RenderedEmail> {
  return {
    subject: serverTranslator(props.locale)('emails.verifyEmail.subject'),
    ...(await both(createElement(VerifyEmail, props))),
  };
}

export async function renderResetPasswordEmail(props: ResetPasswordProps): Promise<RenderedEmail> {
  return {
    subject: serverTranslator(props.locale)('emails.resetPassword.subject'),
    ...(await both(createElement(ResetPasswordEmail, props))),
  };
}

export async function renderWorkspacesEmail(props: WorkspacesEmailProps): Promise<RenderedEmail> {
  return {
    subject: serverTranslator(props.locale)('emails.workspaces.subject'),
    ...(await both(createElement(WorkspacesEmail, props))),
  };
}

export async function renderInvitationEmail(props: InvitationEmailProps): Promise<RenderedEmail> {
  return {
    subject: serverTranslator(props.locale)('emails.invitation.subject', {
      inviter: props.inviter,
      workspace: props.workspace,
    }),
    ...(await both(createElement(InvitationEmail, props))),
  };
}

export type { InvitationEmailProps, ResetPasswordProps, VerifyEmailProps, WorkspacesEmailProps };
