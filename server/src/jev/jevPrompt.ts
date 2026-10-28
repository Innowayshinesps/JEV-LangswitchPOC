import type { EntryType } from "@typesafe-ai/sdk";
import { LanguageCode, SUPPORTED_LANGUAGES } from "../language/languageConfig.js";
import { LanguageUtterance } from "../language/languageState.js";

// The decision is split into two independent questions/calls (run in
// parallel) rather than one combined "which language should the reply use"
// choice. Testing against real closely-related-language pairs (Tamil vs
// Malayalam) showed that including `current_language` in the same request as
// a language-identification question strongly biases the model toward the
// current language for visually/linguistically similar scripts - e.g. a
// clear Malayalam sentence was misclassified as Tamil ~98% of the time when
// current_language="ta" was present in state, but correctly identified as
// Malayalam (~95%+) the moment current_language was removed or set to
// anything else. Splitting into "what language is this" (no current_language
// in state) and "is this substantive enough to count as a real switch" (needs
// current_language + history, but never asked to name a language) removed
// the bias entirely and widened the true/false margins on every test case
// from context.md section 23/24 (e.g. "no switch" cases went from ~0.47
// confidence to ~0.04-0.11; "switch" cases from ~0.53 to ~0.86-0.98).

export const LANGUAGE_ID_INSTRUCTIONS =
  "What language is new_utterance predominantly written or spoken in? Judge strictly from the text itself.";

export const SUBSTANTIVE_INSTRUCTIONS_TEMPLATE = (currentLanguageName: string) => `
Is new_utterance a meaningful, information-carrying statement that actually
contributes to the conversation - as opposed to a name, self-introduction,
isolated number, date, currency amount, brand or product name, technical
term, or a bare acknowledgement?

The conversation's current language is ${currentLanguageName}. Recent
utterances from the current segment are given for context.
`;

export const SUBSTANTIVE_CRITERIA = {
  true: "A real sentence or phrase carrying its own conversational content (a request, a description, an answer, an explicit instruction) - regardless of which language it is in.",
  false:
    'Just a name or self-introduction ("My name is John"), an isolated number/date/amount, a brand/product/technical term by itself, or a bare acknowledgement (yes / no / okay / hello / thanks / sir).',
};

export function buildLanguageIdState(newUtterance: string): EntryType {
  return { new_utterance: newUtterance };
}

export function buildSubstantiveState(
  currentLanguage: LanguageCode,
  segmentHistory: LanguageUtterance[],
  newUtterance: string
): EntryType {
  return {
    current_language: currentLanguage,
    current_language_name: SUPPORTED_LANGUAGES[currentLanguage],
    segment_history: segmentHistory.map((u) => ({ language: u.language, text: u.text })),
    new_utterance: newUtterance,
  };
}
