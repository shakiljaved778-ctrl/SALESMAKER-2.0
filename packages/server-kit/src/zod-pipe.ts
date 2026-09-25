import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validate a body, query or params object against its contract; failures become 400 problems. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    return this.schema.parse(value);
  }
}
