import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme as t } from '../theme.js';

export interface LayoutProps {
  lang: string;
  dir: 'ltr' | 'rtl';
  preview: string;
  heading: string;
  footer: string;
  children: ReactNode;
}

export function Layout({ lang, dir, preview, heading, footer, children }: LayoutProps) {
  return (
    <Html lang={lang} dir={dir}>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: t.canvas,
          fontFamily: t.fontFamily,
          margin: 0,
          padding: '24px 0',
        }}
      >
        <Container
          style={{
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radius,
            maxWidth: '560px',
            padding: '32px',
          }}
        >
          <Text
            style={{
              color: t.actionBg,
              fontSize: t.fontSizeBody,
              fontWeight: 600,
              margin: '0 0 16px',
            }}
          >
            SalesMaker
          </Text>
          <Heading
            as="h1"
            style={{
              color: t.textPrimary,
              fontSize: t.fontSizeTitle,
              lineHeight: t.lineHeightTitle,
              fontWeight: 600,
              margin: '0 0 16px',
            }}
          >
            {heading}
          </Heading>
          {children}
          <Hr style={{ borderColor: t.border, margin: '24px 0 16px' }} />
          <Text style={{ color: t.textTertiary, fontSize: t.fontSizeCaption, margin: 0 }}>
            {footer}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Paragraph({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        color: t.textSecondary,
        fontSize: t.fontSizeBody,
        lineHeight: t.lineHeightBody,
        margin: '0 0 16px',
      }}
    >
      {children}
    </Text>
  );
}

export function CallToAction({ href, label }: { href: string; label: string }) {
  return (
    <Section style={{ margin: '8px 0 24px' }}>
      <Button
        href={href}
        style={{
          backgroundColor: t.actionBg,
          borderRadius: t.radius,
          color: t.actionFg,
          fontSize: t.fontSizeBody,
          fontWeight: 600,
          padding: '10px 16px',
          textDecoration: 'none',
        }}
      >
        {label}
      </Button>
    </Section>
  );
}
