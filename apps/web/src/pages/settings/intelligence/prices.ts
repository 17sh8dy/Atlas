/**
 * Prices the person types for a cloud provider, as dollars per million tokens, and how they are
 * held: thousandths of a dollar, as whole numbers, so nothing is lost to floating point.
 *
 * They feed one thing — the Stats page's spending ESTIMATE — and nothing else. Atlas ships no
 * price list on purpose: prices change, differ by model, and a wrong built-in figure would look
 * like a real bill. What is shown is the person's own number multiplied by the tokens counted.
 */

/** "2.5", "$2.50", "0.075" → 2500, 2500, 75. Empty or unusable → null (no price). */
export function parsePriceMilli(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

/** 2500 → "2.5", 75 → "0.075", null → "". */
export function formatPriceMilli(milli: number | null): string {
  if (milli === null || milli === undefined) return '';
  return String(milli / 1000);
}

/** Whether what was typed is something a price can be made from (blank is fine: it clears it). */
export function priceTextProblem(text: string): string | null {
  if (!text.trim()) return null;
  return parsePriceMilli(text) === null ? 'Enter a number, like 2.50' : null;
}
