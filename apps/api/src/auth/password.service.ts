import { Inject, Injectable } from '@nestjs/common';
import type { BreachedPasswordChecker } from '@sm/integrations';
import { DomainError } from '@sm/server-kit';
import argon2 from 'argon2';
import type { Logger } from 'pino';

import { BREACHED_PASSWORDS, LOGGER } from '../tokens.js';

/** argon2id parameters fixed by §6.1: 64 MB memory, 3 iterations, parallelism 1. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  /** Hash verified when the account does not exist, so response time does not reveal it. */
  private readonly dummyHash: Promise<string>;

  constructor(
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswordChecker,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.dummyHash = argon2.hash('dummy password for timing equalisation', ARGON2_OPTIONS);
  }

  /** Policy (min 12, handled by the contract) + breach check, then argon2id. */
  async hashNew(password: string): Promise<string> {
    await this.assertNotBreached(password);
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }

  private async assertNotBreached(password: string): Promise<void> {
    const count = await this.breached.breachCount(password).catch((err: unknown) => {
      // Fail open: an unreachable breach API must not block sign-ups or resets (§11.3).
      this.logger.warn({ err }, 'breached-password check unavailable; skipping');
      return 0;
    });
    if (count > 0) {
      throw new DomainError(
        'validation_failed',
        400,
        'This password has appeared in a data breach',
        [
          {
            field: 'password',
            code: 'breached',
            message: 'This password has appeared in a data breach. Choose a different one.',
          },
        ],
      );
    }
  }
}
