import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Class merging aware of the SalesMaker type scale: without this, tailwind-merge would treat
 * `text-body` (a size) and `text-fg` (a colour) as the same group and drop one of them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'title-1',
            'title-2',
            'title-3',
            'body',
            'body-strong',
            'body-sm',
            'cell',
            'label',
            'caption',
            'micro',
          ],
        },
      ],
      shadow: [{ shadow: ['e1', 'e2', 'e3'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
