// Add more languages here to support them everywhere - JEV's choice options,
// its prompt's supported-language list, and Gemini's system instruction all
// derive from this map (context.md section 7).
export const SUPPORTED_LANGUAGES = {
  ta: "Tamil",
  en: "English",
  hi: "Hindi",
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;

export function isSupportedLanguage(value: string): value is LanguageCode {
  return value in SUPPORTED_LANGUAGES;
}

// Tried a BCP-47 languageCodes hint on Gemini's inputAudioTranscription
// (ta-IN/en-IN/hi-IN) to fix Tamil speech occasionally being transcribed in
// Devanagari (Hindi script). Two more rounds of live testing kept showing
// mis-transcription into Hindi regardless, including a case the hint
// plausibly made worse (a plainly English phrase written entirely in
// Devanagari). Reverted in geminiLive.ts back to plain auto-detect - no
// confirmed evidence either version is reliably better for this speaker's
// heavy three-way code-switching, and a wrong hint isn't free.

export const MAX_SEGMENT_HISTORY = 3;

export const INITIAL_LANGUAGE: LanguageCode = "ta";

// Measured latency for genuinely distinct utterances (not a repeated/cached
// prompt): consistently ~750-800ms, occasionally ~1.1-1.2s, with some
// sessions running slower throughout (a live 5-utterance round measured 4 of
// 5 calls over 1000ms). Repeated-identical test calls looked much faster
// (~300ms) but that turned out to be response caching on identical input,
// not real warmth - real conversational content is unique every time, so it
// doesn't benefit from that. 1200ms was still clipping a meaningful fraction
// of legitimate slow-but-real decisions right at the boundary (2 of 5 in
// that round timed out with no decision at all); 1600ms covers more of the
// real distribution while staying well clear of the old multi-second
// retry-storm this used to cause (see jevClient.ts's retry:0).
export const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 1600);

export const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";

// How long the server holds back a fresh turn's audio from the browser while
// waiting for JEV's decision on the utterance that triggered it. Without
// this, Gemini's own response reliably starts streaming before JEV resolves,
// so even with the interrupt-based switch (GeminiLiveAdapter.setLanguage),
// the caller briefly hears a snippet of the OLD language before the cut -
// jarring even once the cut itself is click-free. Holding audio for this
// window means a switch decision that arrives within it never reaches the
// speaker in the wrong language at all: the held chunks are just discarded
// instead of played. If JEV is slower than this, held audio is released
// as-is and the turn falls back to the old (still correct, just not gapless)
// interrupt-after-the-fact behavior.
//
// This MUST be >= JEV_TIMEOUT_MS. It used to be a separate, shorter 350ms
// constant on the reasoning that most decisions land well under that - but
// real JEV latency turned out to have enough spread (300ms-1.2s, not a tight
// cluster) that a lot of genuinely-fine, on-time decisions were arriving
// *after* the 350ms cap had already given up and released the old-language
// audio - exactly the leakage this window exists to prevent. Since
// JEV_TIMEOUT_MS already defines "the longest we'll wait for a decision at
// all", the hold has no reason to be shorter than that - any gap between the
// two is pure leakage window with no benefit.
//
// This is a ceiling, not a fixed delay: release happens the moment JEV
// actually resolves, whichever is sooner, so a fast decision (which is most
// of them) isn't slowed down by raising this - only the slow tail is now
// covered instead of leaking.
export const AUDIO_HOLD_MS = Number(process.env.AUDIO_HOLD_MS ?? JEV_TIMEOUT_MS + 150);

// After sending the interrupting language-switch note (GeminiLiveAdapter's
// setLanguage), there's still a real network round-trip before Gemini's
// backend actually stops the old turn's generation. Chunks it emits during
// that gap arrive at us looking like ordinary new audio (the hold has
// already been released for this turn) and get forwarded straight through -
// audible as a brief garbled/wrong-language blip right before the real
// new-language reply cuts in. Dropping (not holding - discarding outright)
// audio chunks for a short window right after the interrupt swallows that
// straggler instead of playing it.
export const POST_SWITCH_SQUELCH_MS = Number(process.env.POST_SWITCH_SQUELCH_MS ?? 220);

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";
