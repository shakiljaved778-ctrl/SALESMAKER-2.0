import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/index.css';

import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';

type Globals = { theme: string; density: string; dir: string; locale: string };

/** Apply the toolbar choices exactly as the app does: attributes on <html> (§9.5, §9.6, §9.12). */
const withShellAttributes: Decorator = (Story, context) => {
  const { theme, density, dir, locale } = context.globals as Globals;
  useEffect(() => {
    const html = document.documentElement;
    html.dataset['theme'] = theme;
    html.dataset['density'] = density;
    html.dir = dir;
    html.lang = locale;
  }, [theme, density, dir, locale]);
  return (
    <div className="min-h-dvh bg-canvas p-6 text-fg">
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withShellAttributes],
  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: ['light', 'dark', 'system'],
        dynamicTitle: true,
      },
    },
    density: {
      description: 'Density',
      toolbar: {
        title: 'Density',
        icon: 'component',
        items: ['comfortable', 'default', 'compact'],
        dynamicTitle: true,
      },
    },
    dir: {
      description: 'Text direction (ar-XB proves RTL mirroring with English strings)',
      toolbar: { title: 'Direction', icon: 'transfer', items: ['ltr', 'rtl'], dynamicTitle: true },
    },
    locale: {
      description: 'Locale',
      toolbar: {
        title: 'Locale',
        icon: 'globe',
        items: ['en', 'en-XA', 'ar-XB'],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light', density: 'default', dir: 'ltr', locale: 'en' },
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
};

export default preview;
