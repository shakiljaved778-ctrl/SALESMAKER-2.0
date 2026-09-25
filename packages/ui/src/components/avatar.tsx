'use client';

import { Avatar as AvatarPrimitive } from 'radix-ui';

import { cn } from '../lib/cn.js';

const SIZES = {
  16: 'size-4 text-[0.5rem]',
  20: 'size-5 text-[0.5625rem]',
  24: 'size-6 text-micro',
  32: 'size-8 text-label',
  40: 'size-10 text-body',
} as const;
/** Categorical fallbacks, skipping slot 3 (Iris is reserved for AI). */
const FALLBACK_TONES = [
  'bg-cat-1-bg text-cat-1-fg',
  'bg-cat-2-bg text-cat-2-fg',
  'bg-cat-4-bg text-cat-4-fg',
  'bg-cat-5-bg text-cat-5-fg',
  'bg-cat-6-bg text-cat-6-fg',
  'bg-cat-7-bg text-cat-7-fg',
  'bg-cat-8-bg text-cat-8-fg',
] as const;
const PRESENCE = {
  available: 'bg-success',
  busy: 'bg-danger',
  away: 'bg-warning',
  offline: 'bg-fg-disabled',
} as const;

export type Presence = keyof typeof PRESENCE;

/** Up to two initials from a display name. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}

/** Deterministic tone per name, so a person keeps the same colour everywhere. */
export function toneOf(name: string): (typeof FALLBACK_TONES)[number] {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_TONES[hash % FALLBACK_TONES.length] ?? FALLBACK_TONES[0];
}

export interface AvatarProps {
  name: string;
  src?: string | undefined;
  size?: keyof typeof SIZES;
  /** Agent state dot (§9.10); pair with a text label nearby — colour is never the only signal. */
  presence?: Presence;
  presenceLabel?: string;
  className?: string;
}

/** Avatar (§9.10): 16–40 px, image with initials fallback in a deterministic colour, presence dot. */
export function Avatar({ name, src, size = 24, presence, presenceLabel, className }: AvatarProps) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <AvatarPrimitive.Root
        className={cn(
          'inline-flex items-center justify-center overflow-hidden rounded-full',
          SIZES[size],
        )}
      >
        {src ? (
          <AvatarPrimitive.Image src={src} alt={name} className="size-full object-cover" />
        ) : null}
        <AvatarPrimitive.Fallback
          className={cn('flex size-full items-center justify-center font-semibold', toneOf(name))}
          delayMs={src ? 300 : 0}
        >
          <span aria-hidden="true">{initialsOf(name)}</span>
          <span className="sr-only">{name}</span>
        </AvatarPrimitive.Fallback>
      </AvatarPrimitive.Root>
      {presence ? (
        <span
          role="img"
          aria-label={presenceLabel ?? presence}
          className={cn(
            'absolute -bottom-0.5 -end-0.5 size-2.5 rounded-full ring-2 ring-surface',
            PRESENCE[presence],
          )}
        />
      ) : null}
    </span>
  );
}
