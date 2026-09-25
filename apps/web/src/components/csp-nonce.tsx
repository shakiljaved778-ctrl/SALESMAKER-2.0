'use client';

import { setNonce } from 'get-nonce';

/**
 * Hands this request's CSP nonce to the style injector Radix uses for scroll locking
 * (react-style-singleton reads it through get-nonce), so its <style> passes `style-src`.
 */
export function CspNonce({ nonce }: { nonce: string }) {
  setNonce(nonce);
  return null;
}
