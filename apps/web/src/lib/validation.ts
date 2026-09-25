/** Client-side checks mirror the contracts, so most mistakes are caught before a round trip. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SLUG = /^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MIN_PASSWORD = 12;

/** "Pixelcraft Studio, Ltd." → "pixelcraft-studio-ltd" (the suggested workspace address). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
