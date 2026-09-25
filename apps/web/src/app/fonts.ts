import localFont from 'next/font/local';

/**
 * Self-hosted, no network at build or run time (§9.3). Inter Variable for UI, JetBrains Mono for
 * IDs and code. IBM Plex Sans Arabic is declared in the token font stack but not loaded until RTL
 * ships. Latin subset only for v1 (English UI).
 */
export const inter = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
});

export const jetbrainsMono = localFont({
  src: '../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-jetbrains-mono',
});
