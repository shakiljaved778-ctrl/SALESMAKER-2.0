import { z } from 'zod';

/** Keyset pagination query (§10.1): max 200 per page, opaque cursor. */
export const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).optional(),
  })
  .meta({ id: 'PageQuery' });

/** A page of items with the cursor for the next page (null when there is none). */
export function cursorPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
