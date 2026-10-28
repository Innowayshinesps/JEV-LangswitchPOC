// Lightweight pre-filter: eliminate utterances that obviously carry no language
// evidence (bare numbers, currency amounts, single common acknowledgements) so
// they never reach JEV. This is intentionally tiny - JEV remains the primary
// decision-maker for anything with real content (see context.md section 15).

const ACK_WORDS = new Set([
  "yes", "no", "okay", "ok", "sir", "madam", "thanks", "thank you",
  "hello", "hi", "hey", "bye", "otp",
]);

const NUMBER_OR_CURRENCY_ONLY = /^[\s₹$]*[\d][\d,.\s]*[\s₹$%]*$/;

export function shouldSkipJev(utterance: string): boolean {
  const trimmed = utterance.trim();
  if (trimmed.length === 0) return true;
  if (NUMBER_OR_CURRENCY_ONLY.test(trimmed)) return true;

  const normalized = trimmed.toLowerCase().replace(/[.,!?]+$/, "");
  if (ACK_WORDS.has(normalized)) return true;

  return false;
}
