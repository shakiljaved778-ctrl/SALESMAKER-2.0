/**
 * Email palette and type, taken from the §9.2/§9.3 tokens. Emails are always light and use
 * colours that stay legible when a client forces dark mode (§9.6). Inline styles only: many email
 * clients ignore <style> blocks and CSS variables.
 */
export const emailTheme = {
  canvas: '#F6F7F8', // graphite-50
  surface: '#FFFFFF',
  border: '#E1E4E8', // graphite-200
  textPrimary: '#14181E', // graphite-900
  textSecondary: '#4C5561', // graphite-600
  textTertiary: '#6B7480', // graphite-500
  actionBg: '#117567', // jade-600
  actionFg: '#FFFFFF',
  link: '#0E5F54', // jade-700
  fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSizeBody: '14px',
  fontSizeTitle: '22px',
  fontSizeCaption: '12px',
  lineHeightBody: '20px',
  lineHeightTitle: '28px',
  radius: '6px',
} as const;
