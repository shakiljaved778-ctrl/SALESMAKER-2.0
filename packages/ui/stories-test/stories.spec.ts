import { readFileSync } from 'node:fs';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

interface IndexEntry {
  id: string;
  type: 'story' | 'docs';
  title: string;
  name: string;
}

const index = JSON.parse(
  readFileSync(new URL('../storybook-static/index.json', import.meta.url), 'utf8'),
) as {
  entries: Record<string, IndexEntry>;
};
const stories = Object.values(index.entries).filter((e) => e.type === 'story');

const variants = [
  { theme: 'light', density: 'default', dir: 'ltr' },
  { theme: 'dark', density: 'default', dir: 'ltr' },
  { theme: 'light', density: 'compact', dir: 'ltr' },
  { theme: 'dark', density: 'compact', dir: 'ltr' },
  { theme: 'light', density: 'default', dir: 'rtl' },
] as const;

for (const story of stories) {
  for (const v of variants) {
    const label = `${story.id} [${v.theme}·${v.density}·${v.dir}]`;
    test(label, async ({ page }) => {
      const globals = `theme:${v.theme};density:${v.density};dir:${v.dir};locale:${v.dir === 'rtl' ? 'ar-XB' : 'en'}`;
      await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=${globals}`);
      await page.waitForSelector('#storybook-root > *');
      await expect(page.locator('html')).toHaveAttribute('data-theme', v.theme);
      await page.evaluate(() => document.fonts.ready);

      const results = await new AxeBuilder({ page }).include('#storybook-root').analyze();
      const blocking = results.violations.filter(
        (x) => x.impact === 'serious' || x.impact === 'critical',
      );
      expect(
        blocking.map((x) => `${x.id}: ${x.help} (${String(x.nodes.length)})`),
        'axe serious/critical',
      ).toEqual([]);

      // Visual review (§13.3): screenshots are compared unless SKIP_VISUAL is set (the blocking a11y pass).
      if (!process.env['SKIP_VISUAL']) {
        await expect(page).toHaveScreenshot(`${story.id}--${v.theme}-${v.density}-${v.dir}.png`, {
          fullPage: true,
        });
      }
    });
  }
}
