import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { isSupportedLanguage, JEV_MODEL, JEV_TIMEOUT_MS, LanguageCode, SUPPORTED_LANGUAGES } from "../language/languageConfig.js";
import { LanguageUtterance } from "../language/languageState.js";
import {
  buildLanguageIdState,
  buildSubstantiveState,
  LANGUAGE_ID_INSTRUCTIONS,
  SUBSTANTIVE_CRITERIA,
  SUBSTANTIVE_INSTRUCTIONS_TEMPLATE,
} from "./jevPrompt.js";

export interface LanguageDecision {
  languageChanged: boolean;
  newLanguage: LanguageCode | null;
  confidence?: number;
  reason?: string;
}

// A switch requires the language-identification call to name a supported,
// different-from-current language AND the substantive-judgment call to be
// reasonably confident this utterance actually carries new content. Testing
// showed a wide margin between "no switch" (~0.04-0.11) and "switch"
// (~0.86-0.98) cases, so 0.5 sits comfortably in the gap.
const SUBSTANTIVE_THRESHOLD = 0.5;

// Constructed lazily (not at module load) so a missing/invalid
// TYPESAFE_API_KEY can't crash the whole server on startup - it should only
// ever cause individual JEV calls to fail, which askJev already treats as a
// "no switch" fallback per context.md section 30/31.
let client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient {
  if (!client) {
    client = new TypeSafeClient({ defaultModel: JEV_MODEL });
  }
  return client;
}

const LANGUAGE_CHOICE_OPTIONS: Record<string, null> = {
  ...Object.fromEntries(Object.keys(SUPPORTED_LANGUAGES).map((code) => [code, null])),
  unclear: null,
};

const REQUEST_OPTIONS = { timeout: JEV_TIMEOUT_MS, retry: { maxRetries: 0 } };

function languageIdCall(newUtterance: string) {
  return getClient().systemOne(
    {
      state: buildLanguageIdState(newUtterance),
      questions: { language: choice(LANGUAGE_ID_INSTRUCTIONS, LANGUAGE_CHOICE_OPTIONS) },
    },
    REQUEST_OPTIONS
  );
}

function substantiveCall(currentLanguage: LanguageCode, segmentHistory: LanguageUtterance[], newUtterance: string) {
  return getClient().systemOne(
    {
      state: buildSubstantiveState(currentLanguage, segmentHistory, newUtterance),
      questions: {
        substantive: noul(SUBSTANTIVE_INSTRUCTIONS_TEMPLATE(SUPPORTED_LANGUAGES[currentLanguage]), SUBSTANTIVE_CRITERIA),
      },
    },
    REQUEST_OPTIONS
  );
}

// Fire-and-forget pings that mirror the real call shapes (not a generic
// placeholder) - a distinct question/state shape appears to need its own
// warm-up on JEV's backend, separate from "is the connection open".
// Measured latency: ~1.1-1.2s stone cold, ~300-400ms once warm - but warmth
// decays between real utterances (natural 10-30s pauses in a live call), so
// both a one-off warm-up and a periodic keep-alive exist to fight that.
function pingJev(): void {
  languageIdCall("hello").catch(() => undefined);
  substantiveCall("ta", [], "hello").catch(() => undefined);
}

// Pings immediately (the first utterance of a call usually lands within a
// few seconds of Start, well before a setInterval's first tick would fire)
// and then every few seconds for the lifetime of a call, so JEV stays warm
// through natural conversational pauses too. Measured: an unpinged ~12-20s
// gap costs ~750-900ms on the next distinct utterance; keeping pings going
// through that same gap brings it back down to ~300-350ms. Returns a stop
// function to call when the session ends.
export function startJevKeepAlive(intervalMs = 8000): () => void {
  pingJev();
  const timer = setInterval(pingJev, intervalMs);
  return () => clearInterval(timer);
}

// context.md section 30/31: JEV must never block or kill the call. Any
// timeout, API error, or unexpected response falls back to "no switch" and
// the caller keeps the conversation going in the current language.
export async function askJev(
  currentLanguage: LanguageCode,
  segmentHistory: LanguageUtterance[],
  newUtterance: string
): Promise<LanguageDecision> {
  try {
    const [languageResult, substantiveResult] = await Promise.all([
      languageIdCall(newUtterance),
      substantiveCall(currentLanguage, segmentHistory, newUtterance),
    ]);

    const detectedLanguage = languageResult.answers.language.choice;
    const substantive = substantiveResult.answers.substantive.noul;

    if (
      detectedLanguage !== "unclear" &&
      isSupportedLanguage(detectedLanguage) &&
      detectedLanguage !== currentLanguage &&
      substantive >= SUBSTANTIVE_THRESHOLD
    ) {
      return { languageChanged: true, newLanguage: detectedLanguage, confidence: substantive };
    }

    return { languageChanged: false, newLanguage: null, confidence: substantive };
  } catch (err) {
    return {
      languageChanged: false,
      newLanguage: null,
      reason: `JEV failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
