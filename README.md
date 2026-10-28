# JEV + Gemini Live — Seamless Language Switching POC

A minimal browser voice-call POC that tests whether [Jev](https://docs.typesafe.ai/introduction)
(TypeSafe AI's structured decision model) can reliably decide, in real time, when a caller has
genuinely switched spoken language (Tamil / English / Hindi) — so a [Gemini Live](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
voice agent, acting as a hospital front-desk receptionist, can continue naturally in the new
language on the very next reply, without asking the user to repeat themselves.

See [`context.md`](./context.md) for the full design spec this implements, and
[`JEV_INTEGRATION_NOTES.md`](./JEV_INTEGRATION_NOTES.md) for how the JEV integration and its
latency/cleanliness fixes were actually arrived at (bugs found, measurements taken, dead ends).

## Architecture

```
Browser (React/Vite)  <--WebSocket-->  Node server  <-->  Gemini Live (STT + LLM + TTS)
                                            |
                                            +-->  JEV (language-switch decision)
```

- **Gemini** hears and responds, playing a hospital receptionist (booking/rescheduling
  appointments, department/hours questions). It never decides the language on its own.
- **JEV** decides, per completed user utterance, whether the conversation's language has genuinely
  changed — given only the current language and the last 3 utterances of the current segment
  (not the full transcript). This runs as two parallel Jev calls rather than one: a plain
  language-identification `choice` (given only the new utterance, no current-language context) and
  a `noul` judgment of whether the utterance is substantive enough to count as a real switch (given
  the current language + history, but never asked to name a language). Testing found that asking a
  single combined question ("which language should the reply use, given current_language=X")
  strongly biased the model toward the current language whenever the new utterance was in a
  closely-related script (this surfaced during testing with a since-removed fourth language,
  Malayalam, which is visually/linguistically close to Tamil). Splitting the two questions removed
  the bias and widened the decision margins significantly (see `jevPrompt.ts` for the details and
  `jevClient.ts` for how the two results are combined) — see `JEV_INTEGRATION_NOTES.md` for the full
  story with numbers.
- **The application** (`LanguageSwitchManager`) owns the language state and tells Gemini which
  language to speak next, via a steering note sent into the *same* live session (Gemini Live
  doesn't support changing `systemInstruction` mid-session, so a `[LANGUAGE: xx]` note is injected
  as client content instead of tearing the session down).

## Prerequisites

- Node.js 20+
- A Gemini API key with access to `gemini-3.1-flash-live-preview` (or another Live model)
- A TypeSafe AI (Jev) API key

## Setup

```bash
cp .env.example .env
# edit .env and fill in GEMINI_API_KEY and TYPESAFE_API_KEY
npm install
npm run dev
```

This starts the backend on `http://localhost:3001` (WebSocket on the same port) and the Vite dev
server on `http://localhost:5173`. Open the browser URL, click **Start Call**, grant microphone
access, and talk.

## Env vars

| Var | Meaning |
|---|---|
| `GEMINI_API_KEY` | Gemini API key (server-side only, never sent to the browser) |
| `GEMINI_MODEL` | Live model id, defaults to `gemini-3.1-flash-live-preview` |
| `TYPESAFE_API_KEY` | Jev API key. The real `@typesafe-ai/sdk` client reads this exact env var name automatically (context.md's spec calls it `JEV_API_KEY`, but that name doesn't match the actual SDK) |
| `JEV_MODEL` | Jev model, defaults to `jev-latest` |
| `JEV_TIMEOUT_MS` | Per-attempt JEV timeout (retries are disabled - see below); on timeout/error the app falls back to "no switch" and keeps the call going. Defaults to 1200ms - real (non-cached) Jev latency measured consistently at ~750-800ms with occasional ~1.2s outliers |
| `PORT` | Backend port, defaults to `3001` |
| `VITE_WS_URL` | Only needed if the client isn't on the same machine as the server |

## What to test

Speak into the mic and watch the debug log:

- Tamil, Tamil, Tamil → no switches.
- Tamil a few times, then a genuine English sentence ("I need help with my payment") → single
  decision, switch to English logged immediately, and the *next* spoken reply is in English.
- A bare number ("21"), a currency amount, a name, or a single word ("payment") → no switch.
- An explicit request ("please speak in English" / "தமிழில் பேசுங்கள்") → immediate switch.
- Switch to Hindi mid-conversation → switch detected and applied the same way.

The debug log shows, per utterance: the transcript, current language, JEV's decision, whether it
was prefiltered (skipped JEV entirely), JEV latency, and decision latency — this is the data needed
to judge whether JEV is fast/accurate enough for a production call path (context.md sections 22–24).

Click **Stop Call** to end the session (closes the mic and the Gemini Live session); click **Start
Call** again for a fresh session, which always begins in Tamil.

## Known limitations of this POC

- Language steering is injected as a `sendClientContent` note rather than a system-instruction
  update, because the Live API does not support changing `systemInstruction` while a session is
  open. It's reliable in testing but is the piece most worth re-verifying if Google changes the
  Live API.
- Because Gemini's own turn generation can start before the JEV decision comes back, the reply to
  the *triggering* utterance may still play in the old language if JEV is slow; the switch is
  guaranteed from the next reply onward. In practice, measured "first audio after switch" latency
  (time from JEV's decision to Gemini's first audio in the new language) is only ~30-80ms, so
  Gemini is almost always still waiting on that utterance when the decision lands.
- JEV's own decision latency (~300-400ms once "warm", ~750-800ms typical for genuinely new
  content, occasionally ~1.2s) is the dominant source of added latency, not our own code. The
  SDK's **default retry policy retries on timeout** (2 retries, 500ms backoff) which turned a single
  slow attempt into 1.3-2.8s of total latency in initial testing - this is now disabled
  (`retry: { maxRetries: 0 }`) in favor of one attempt, a hard cutoff, and an immediate "no switch"
  fallback. A one-off warm-up call fires when a call starts, plus a periodic keep-alive ping every
  8s for the call's duration, to fight backend cold-starts - but note that identical repeated
  requests appear to hit response caching (fast, ~300ms), which doesn't reflect the latency of
  genuinely new spoken content (~750-800ms) - don't be misled by a quick synthetic benchmark here.
- Single WebSocket connection per browser tab, one Gemini Live session per call. No reconnect/retry
  logic, no persistence — intentionally out of scope for this POC.
