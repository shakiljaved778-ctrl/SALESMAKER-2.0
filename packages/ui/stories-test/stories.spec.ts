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

/**
 * Known contrast failures that come from locked §9.2 tokens awaiting an owner decision
 * (docs/spec/OPEN_QUESTIONS.md). Only the listed elements, in the listed theme, are excluded
 * from the axe run; everything else stays blocking. Remove an entry once its question is settled.
 */
const PENDING_OWNER_DECISION: Record<string, Partial<Record<'light' | 'dark', string[]>>> = {
  // Q28: white on danger-500 is 4.11:1 in dark.
  'components-button--variants': { dark: ['[data-variant="danger"]'] },
};

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

      // Whole page: Radix renders overlays in portals outside #storybook-root.
      let axe = new AxeBuilder({ page });
      for (const selector of PENDING_OWNER_DECISION[story.id]?.[v.theme] ?? [])
        axe = axe.exclude(selector);
      const results = await analyzeWhenIdle(axe);
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

/**
 * The Storybook a11y addon runs axe in the same frame when a story loads; axe refuses concurrent
 * runs, so wait for the addon's run to finish instead of failing on the race.
 */
async function analyzeWhenIdle(axe: AxeBuilder) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await axe.analyze();
    } catch (err) {
      if (attempt >= 20 || !String(err).includes('Axe is already running')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
