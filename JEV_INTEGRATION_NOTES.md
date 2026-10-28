# JEV Integration: How Language Switching Got Fast and Clean

This documents what was actually built to make JEV-driven language switching
work in a live Gemini voice call — including the dead ends, the measurements
that overturned my own assumptions, and why the code ended up shaped the way
it did. It's a companion to [`README.md`](./README.md) (setup/usage) and
[`context.md`](./context.md) (the original spec); this one is about *how we
got there*.

Everything below is backed by real API calls against the live JEV and Gemini
Live services during development — numbers are measured, not estimated,
unless marked otherwise.

---

## 1. The starting design: one JEV call, one question

The first version asked JEV a single `choice` question per utterance:
*"which language should the assistant's next reply use — ta / en / hi /
no_change?"* — with a long instruction block encoding the "don't switch on a
bare number/name/ack, do switch on a genuine sentence" rules from
`context.md` section 9.

This worked, but had two separate problems, discovered in two separate
rounds of live testing.

---

## 2. Problem 1: JEV "latency" of 1.3–2.8 seconds

First real test results showed JEV taking 1.3–2.8 seconds per decision —
far too slow for a live call, and the whole reason "switch to English" only
ever landed on the *next* exchange instead of the one that triggered it.

**Root cause, found by reading the SDK source, not guessing:** `@typesafe-ai/sdk`'s
`RequestOptions.timeout` is documented as *"Timeout per attempt in
milliseconds; there is no total retry budget."* The client's default retry
policy (`DEFAULT_RETRY_POLICY`) does **2 retries with exponential backoff**
on timeout. A 500ms timeout with 2 retries and backoff can easily add up to
2.5–3s of *total* latency for a single decision — exactly matching what was
observed.

**Fix:** `retry: { maxRetries: 0 }` on every call — one attempt, a hard
cutoff, immediate fallback to "no switch" on timeout (which is what the spec
actually asked for in section 31 anyway; retries were never part of the
design, they're just the SDK's default).

**Measuring the real floor**, once retries were off:

| Condition | Latency |
|---|---|
| First call on a fresh client (cold) | ~1.2s |
| Repeated identical request, back-to-back | ~300ms |
| Genuinely distinct utterance, no recent activity | ~750–900ms |
| Genuinely distinct utterance, backend kept warm | ~300–400ms |

The "repeated identical request" number was initially misread as "the warm
latency" — a rapid-fire benchmark using the same static sentence in a loop
looked great (~300ms after the first two calls). It turned out that was
**response caching on identical input**, not real warmth: live conversation
never repeats the same sentence, so that number doesn't transfer. The
"genuinely distinct utterance" rows are what actually matters, and they're
the ones the rest of this document is about closing the gap on.

`JEV_TIMEOUT_MS` was tuned from context.md's suggested 500ms → 800ms → the
current **1200ms**, each time re-measured against real (non-cached) calls
rather than assumed.

---

## 3. Problem 2: Malayalam was being misread as Tamil

Once Malayalam was added as a 4th language, it wouldn't switch. A real
Malayalam sentence (`എനിക്ക് നാളെ രാവിലെ ഒരു ഡോക്ടർ അപ്പോയിന്റ്മെന്റ് വേണം.`)
came back classified as Tamil with 98% confidence.

**Isolated test to find out why:** asked JEV to *purely* identify the
language of that exact sentence, no other context — it got Malayalam right
at 99% confidence. So the model *can* tell them apart. The bug had to be in
how the question was being asked.

**The actual cause**, isolated by testing the same sentence with different
`current_language` values in the request state:

| `current_language` in state | Detected language |
|---|---|
| `ta` | **ta** (0.98 confidence — wrong) |
| `en` | ml (0.97 — correct) |
| `hi` | ml (0.96 — correct) |
| `ml` | ml (0.99 — correct) |

Merely *including* `current_language: "ta"` in the same request as the
utterance biased the model toward Tamil for this specific pair — plausibly
because Tamil and Malayalam are the two most visually/linguistically related
languages in the supported set, and the model defaults toward "close to
current" under uncertainty. Removing `current_language` from that call's
state entirely fixed it outright.

**Fix — split into two independent parallel calls, run with `Promise.all`:**

1. **Language ID** (`choice`): *"What language is `new_utterance`
   predominantly written or spoken in?"* — state is **just the utterance**,
   nothing else. No bias, because there's no `current_language` to anchor
   to.
2. **Substantive judgment** (`noul`): *"Is `new_utterance` a meaningful,
   information-carrying statement — as opposed to a name, isolated number,
   acknowledgement, etc.?"* — state includes `current_language` and
   history (it needs that context), but the question **never asks it to
   name a language**, so the bias has nothing to attach to.

Application code combines them: switch only if the detected language is
supported, differs from current, *and* the substantive score clears a
threshold.

This also fixed a second, unrelated defect the original single-question
design had: a first pass at this split combined "which language" with
"is this genuine" in one `noul` question and got "My name is John" scoring
0.76 (would incorrectly switch) versus a genuine English sentence at 0.86 —
too close together to be reliable. Reframing the question as pure
"substantive vs. not" (with no language-naming at all) widened that margin
to **0.04–0.11 for non-switches vs. 0.86–0.98 for genuine switches** — a
comfortable gap for a fixed `0.5` threshold instead of a coin flip.

Verified against all 12 of `context.md`'s test cases (section 23), including
Tamil↔Malayalam in both directions, before shipping.

---

## 4. Problem 3: the switch still landed one exchange late

Even at ~300–800ms JEV latency, the *spoken* reply to the triggering
utterance still came out in the old language, with the switch only visibly
taking effect on the *next* reply.

**Cause:** the steering note (`sendClientContent` with `turnComplete: false`)
was designed to be non-disruptive — it just queues as context for whatever
Gemini does next. But Gemini's own response generation reliably starts
*faster* than our JEV round trip (even at 300ms), so by the time the note
arrived, Gemini had usually already committed to a reply in the old
language. The note just got picked up on the turn *after* that.

**Fix:** send the note with `turnComplete: true` instead, which the Live API
docs describe as interrupting any in-progress generation. Since the user's
full utterance (audio + transcript) is already in Gemini's context by the
time this fires, this doesn't cut the *user* off — it cuts off Gemini's own
in-progress or about-to-start reply in the old language, and forces it to
respond fresh, now with the language instruction included.

Result: "first audio after switch" (time from the interrupt to the next
audio chunk reaching the browser) dropped to **10–100ms** in real testing,
down from a full extra exchange (several seconds). *(Later found to be
measuring something misleading — see §7.)*

---

## 5. Problem 4: the interrupt itself sounded jarring

Fixing #4 introduced a new, more subtle problem, found across three rounds
of real voice testing:

**4a — an audible click at the cut.** `AudioBufferSourceNode.stop()` jumps
the waveform straight to zero wherever it happened to be — a textbook
click/pop. **Fix:** route playback through a `GainNode` per chunk; `flush()`
ramps gain to 0 over 8ms before stopping, and the first chunk after a flush
ramps back up from 0 the same way.

**4b — a full second of the old language, cleanly cut, but still heard.**
The click was gone, but the user could still hear ~1s of Hindi before it cut
to English. The click-fix only made the *cut* clean — it didn't stop the old
audio from playing in the first place, since Gemini's audio was already
streaming to the browser before the JEV decision (and thus the interrupt)
existed. **Fix:** the server now holds back a fresh turn's audio (buffers it
server-side, doesn't forward to the browser) for up to `AUDIO_HOLD_MS`
(350ms) while JEV's decision is in flight. If the decision is a switch and
arrives within that window, the held audio is discarded outright — the
browser never receives it, so there's nothing to hear before the cut. If
JEV is slower than the hold window, the held audio is released as-is and
the turn falls back to interrupt-after-the-fact (still correct, just not
gapless) — a deliberate, capped trade-off so the *common*, non-switch case
never pays more than ~350ms of extra latency.

**4c — a brief garbled blip right as the new language kicks in.** Even after
4a and 4b, a split-second of "trying to say something" was audible right
before the real new-language reply. **Cause:** sending the interrupt doesn't
stop Gemini instantaneously — there's a real network round trip before its
backend actually halts the old generation. Audio chunks it emits during that
gap arrive looking like ordinary new audio (the hold has already been
released for this turn) and were being forwarded straight through.
**Fix:** a short "squelch" window (`POST_SWITCH_SQUELCH_MS`, 220ms) right
after sending the interrupt, during which incoming audio chunks are dropped
outright rather than forwarded or played.

Confirmed clean by the user after all three of these landed together.

---

## 6. Problem 5: the first utterance of every call was always slow

Found while specifically hunting for more speed (with instructions *not* to
touch anything in §5, since that was confirmed working). A periodic "keep
JEV warm" ping already existed (`startJevKeepAlive`, every 8s) — but it only
used `setInterval`, whose first tick doesn't fire until 8 seconds in. A user
typically starts talking within a few seconds of clicking Start, so the
*first* utterance of every call was paying the full cold-start cost
(~900ms–1.2s) regardless.

**Fix:** fire one ping immediately when the call starts, in addition to the
interval. Measured effect: the first real decision of a session dropped from
a cold ~900ms–1.2s to **~374ms**.

Separately measured, to make sure the 8s keep-alive interval itself was
still worth having (given the "identical request caching" false lead from
§2): a genuinely distinct utterance after a 12–20s gap costs **~750–900ms**
with no pings running during the gap, vs. **~285–334ms** with pings running
every 5–8s through it. 8s and 5s intervals measured identically at the time,
so the existing 8s cadence wasn't leaving anything on the table (§7 revisits
this with a more realistic gap pattern and finds more variance than this
first pass suggested).

---

## 7. The real floor: Gemini's own regeneration time (~800ms)

Once §5's leakage/click/blip fixes landed, "first audio after switch" — now
measuring genuinely new, correct-language audio instead of a stale
old-language chunk still mid-stream — settled to a **consistent ~800–860ms
across every switch**, regardless of whether JEV itself was fast (291ms) or
slow (856ms) for that decision. That independence from JEV's own latency is
the tell: this is Gemini's own cost to abandon a generation and produce a
fresh one from scratch after being interrupted, not something JEV-side
tuning touches.

**Tried:** nudging the interrupt note to ask for a shorter, more immediate
reply (`"Respond now, briefly."`), on the theory that streaming TTS starts
as soon as the first few words exist, so a shorter opening should reach
audio sooner.

**Result: made it worse on both axes.** Live testing showed "first audio
after switch" *increase* to ~1050–1260ms, and introduced a new stutter/
"jerk" right at the start of the reply that wasn't there before. Reverted
immediately - the code has a comment at the revert site so this isn't
retried blind later.

Also re-verified the JEV-side keep-alive was already near its ceiling: a
realistic simulation with 6–14s gaps (matching real conversational pacing)
under the existing 8s keep-alive still produced results from 343ms to
1216ms with no clear pattern - genuine backend jitter on JEV's end for
novel content, not something the client can smooth out further.

**Net conclusion:** the remaining latency splits into two largely-external
floors - JEV's own decision variance (~300ms best case, occasionally over
1s) and Gemini's own post-interrupt regeneration time (~800ms, fairly
fixed) - and neither has a verified safe lever left to pull from this side
of the integration.

---

## 8. Where things landed

- JEV decisions: ~300–400ms once warm (the common case, given the keep-alive
  fixes above), occasionally 750ms–1.2s for a cold or unusually slow call -
  variance that live testing (§7) suggests is inherent backend jitter, not
  something further tuned away.
- First audio after a confirmed switch: ~800–860ms, consistently, with no
  audible old-language leakage or click (§5's fixes cover that part).
- All 12 of context.md's test cases pass, including the Tamil↔Malayalam pair
  that originally failed.

## 9. Tunables (all in `.env`, see `.env.example`)

| Var | Default | What it trades off |
|---|---|---|
| `JEV_TIMEOUT_MS` | 1200 | Lower = faster fallback-to-no-switch on a slow call, but more missed switches on real (non-cached) latency spikes. |
| `AUDIO_HOLD_MS` | 350 | Higher = catches more switch decisions before any audio plays (cleaner), but delays the start of *every* reply, including non-switches. |
| `POST_SWITCH_SQUELCH_MS` | 220 | Higher = more reliably swallows the post-interrupt blip, but risks clipping the very start of a fast new-language reply. |

## 10. What wasn't chased further

- **JEV's own inference latency floor (~300ms warm)** — this is Jev's
  backend, not something tunable from here. No documented "faster" model
  tier was found; guessing at an undocumented model name would violate the
  "don't invent API surfaces" constraint this whole project has stuck to.
- **Sending partial/interim transcripts to JEV** to start the decision
  before the user finishes speaking — explicitly ruled out by context.md
  section 14 (unstable, wastes requests), and not attempted.
