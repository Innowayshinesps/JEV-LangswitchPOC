# Artifact — JEV + Gemini Live Seamless Language Switching POC

> **Give this entire document to Claude Code.**
>
> The goal is to build a minimal working POC first. Do not add unnecessary infrastructure, UI, databases, authentication, Exotel, AWS deployment, or external speech-LID models yet.

---

# 1. Objective

Build a browser-based voice conversation POC using:

* **Gemini Live** — speech-to-text, conversational intelligence, and text-to-speech/live audio
* **JEV** — the language-switch decision maker
* **Application Language State Manager** — maintains the current language and language-segment history

The key feature to test is:

> **If the user naturally switches from one language to another during an ongoing conversation, the agent should switch to that language immediately after that utterance, without requiring two confirmations or making the user repeat themselves.**

Example:

```text
Agent starts in Tamil.

User: Tamil sentence
Agent: Tamil

User: Tamil sentence
Agent: Tamil

User: "I need help with my payment."
             ↓
           JEV
             ↓
      Switch to English
             ↓
Agent: English
```

Then:

```text
User: English sentence
Agent: English

User: "எனக்கு இதை தமிழில் சொல்லுங்கள்"
             ↓
           JEV
             ↓
      Switch to Tamil
             ↓
Agent: Tamil
```

---

# 2. Core Architecture

```text
┌──────────────────────┐
│      Browser         │
│                      │
│  Microphone          │
│  Start / Stop        │
│  Current Language    │
│  Debug Log           │
└──────────┬───────────┘
           │
           │ WebSocket
           ▼
┌──────────────────────┐
│    Node Backend      │
│                      │
│  Gemini Live         │
│  JEV                  │
│  Language Manager    │
└──────────┬───────────┘
           │
           │
     ┌─────┴─────┐
     ▼           ▼
┌─────────┐  ┌──────────────┐
│ Gemini  │  │     JEV      │
│  Live   │  │              │
│         │  │ Language     │
│ STT     │  │ switch       │
│ LLM     │  │ decision     │
│ TTS     │  │              │
└─────────┘  └──────────────┘
```

The important separation is:

```text
Gemini = hears + understands + responds

JEV = decides language

Application = maintains language state
```

Do **not** make Gemini responsible for deciding whether a language switch has happened.

---

# 3. Technology

Use:

### Frontend

* React
* Vite
* TypeScript
* Web Audio API
* WebSocket

### Backend

* Node.js
* TypeScript
* WebSocket
* Gemini Live SDK/API
* JEV SDK/API

### Do NOT add

* Exotel
* AWS deployment
* PostgreSQL
* Redis
* authentication
* user accounts
* dashboards
* external speech-language-identification models
* SpeechBrain
* NeMo
* fastText
* JEV history database
* LangChain
* unnecessary abstractions

This is a **language-switching experiment**, not a production system.

---

# 4. Important Design Decision

## Do NOT use a two-confirmation system

Do **not** implement:

```text
English detected
    ↓
wait
    ↓
English detected again
    ↓
switch
```

We specifically want to test:

```text
Current language = Tamil

User speaks a meaningful English sentence
            ↓
           JEV
            ↓
     genuine language switch
            ↓
      switch immediately
```

The purpose of the POC is to determine whether JEV can make this decision reliably enough in a live call.

---

# 5. The Most Important Concept: Language Segments

Do not send the entire conversation transcript to JEV.

Instead, maintain a **current language segment**.

For example:

```text
Tamil segment

T1: "எனக்கு ஒரு payment problem இருக்கு"
T2: "நேற்று அது fail ஆயிடுச்சு"
T3: "என்ன செய்யணும்?"
```

Then the user switches:

```text
"I need help with my payment."
```

JEV receives:

```text
Current language:
Tamil

Recent utterances from current Tamil segment:
1. ...
2. ...
3. ...

New utterance:
"I need help with my payment."
```

JEV decides:

```text
switch = true
new_language = English
```

Then the application changes:

```text
currentLanguage = English
```

And **resets the language history**:

```text
English segment:

E1: "I need help with my payment."
```

The old Tamil history is no longer sent to JEV.

---

# 6. Language State

Create a dedicated state object.

```typescript
interface LanguageState {
  currentLanguage: string;
  segmentHistory: LanguageUtterance[];
  lastSwitchTimestamp: number;
}

interface LanguageUtterance {
  text: string;
  language: string;
  timestamp: number;
}
```

Example:

```typescript
{
  currentLanguage: "ta",
  segmentHistory: [
    {
      text: "எனக்கு ஒரு payment problem இருக்கு",
      language: "ta",
      timestamp: 123456789
    },
    {
      text: "நேற்று payment fail ஆயிடுச்சு",
      language: "ta",
      timestamp: 123456999
    }
  ],
  lastSwitchTimestamp: 123456999
}
```

---

# 7. Supported Languages

Initially support:

```text
Tamil     = ta
English   = en
Hindi     = hi
```

Structure the code so additional languages can easily be added later.

For example:

```typescript
const SUPPORTED_LANGUAGES = {
  ta: "Tamil",
  en: "English",
  hi: "Hindi"
};
```

Do not hard-code language logic throughout the application.

---

# 8. What JEV Should Decide

The central JEV decision should NOT simply be:

> "What language is this sentence?"

Instead ask:

> **"Has the user genuinely changed the language of the ongoing conversation?"**

JEV needs:

```text
1. Current conversation language
2. Recent utterances from the current language segment
3. New user utterance
```

And should return something structured like:

```json
{
  "language_changed": true,
  "new_language": "en"
}
```

or:

```json
{
  "language_changed": false,
  "new_language": "ta"
}
```

If there isn't enough evidence:

```json
{
  "language_changed": false,
  "new_language": "unknown"
}
```

Do not force JEV to choose a language when it isn't confident.

---

# 9. JEV Decision Prompt

Create this as a separate prompt/configuration.

```text
You are a real-time conversation language decision engine.

Your job is to determine whether the user has genuinely changed the language of the ongoing conversation.

You are NOT generating a conversational response.

You are making a structured language decision for another AI voice agent.

You will receive:

1. The language currently being used in the conversation.
2. A small history of recent user utterances from the current language segment.
3. The user's newest utterance.

Determine whether the newest utterance represents a genuine change in the user's conversational language.

Important rules:

- A single number must NOT cause a language switch.
- An age such as "21" must NOT cause a language switch.
- Dates must NOT cause a language switch.
- Currency amounts must NOT cause a language switch.
- Names must NOT cause a language switch.
- Brand names must NOT cause a language switch.
- Product names must NOT cause a language switch.
- Technical terms must NOT cause a language switch by themselves.
- Common acknowledgements such as "yes", "no", "okay", "sir", "thanks", and "hello" must not independently cause a language switch.
- Normal code-switching inside an otherwise consistent conversation should not automatically be treated as a language change.
- A meaningful sentence or utterance clearly establishing another language should be treated as a language change.
- The decision should consider the current conversation language and the recent language segment.
- If the newest utterance clearly establishes another supported language, switch immediately.
- Do not require a second confirmation.
- Do not wait for another utterance.
- If there is insufficient evidence, return no switch.
- If the utterance is ambiguous, return no switch.
- Never invent a language.

Supported languages:

Tamil = ta
English = en
Hindi = hi

Return ONLY the requested structured decision.
Do not generate conversational text.
```

---

# 10. JEV Input Structure

Every meaningful user utterance should produce a JEV decision.

Example:

```json
{
  "current_language": "ta",
  "segment_history": [
    {
      "language": "ta",
      "text": "எனக்கு ஒரு payment problem இருக்கு"
    },
    {
      "language": "ta",
      "text": "நேற்று அது fail ஆயிடுச்சு"
    },
    {
      "language": "ta",
      "text": "என்ன செய்யணும்?"
    }
  ],
  "new_utterance": "I need help with my payment."
}
```

---

# 11. JEV Output

The application should normalize the JEV result into:

```typescript
interface LanguageDecision {
  languageChanged: boolean;
  newLanguage: string | null;
  confidence?: number;
  reason?: string;
}
```

For example:

```json
{
  "languageChanged": true,
  "newLanguage": "en",
  "confidence": 0.96
}
```

Or:

```json
{
  "languageChanged": false,
  "newLanguage": null,
  "confidence": 0.94
}
```

The exact JEV API response format should be adapted to the current JEV SDK/API.

Do not fake a JEV response.

---

# 12. Language Manager Logic

Create:

```text
LanguageSwitchManager.ts
```

Its job is simple.

### Input

```text
currentLanguage
segmentHistory
newUtterance
```

### Process

```text
send to JEV
      ↓
receive decision
      ↓
if languageChanged:
      change language
      clear segment history
      add new utterance to new segment
else:
      add utterance to existing segment
```

Pseudo-code:

```typescript
async function processUtterance(
  utterance: string
): Promise<LanguageDecision> {

  const decision = await askJev({
    currentLanguage: state.currentLanguage,
    segmentHistory: state.segmentHistory,
    newUtterance: utterance
  });

  if (
    decision.languageChanged &&
    decision.newLanguage &&
    decision.newLanguage !== state.currentLanguage
  ) {
    state.currentLanguage = decision.newLanguage;

    state.segmentHistory = [
      {
        text: utterance,
        language: decision.newLanguage,
        timestamp: Date.now()
      }
    ];

    return decision;
  }

  state.segmentHistory.push({
    text: utterance,
    language: state.currentLanguage,
    timestamp: Date.now()
  });

  trimHistory();

  return decision;
}
```

---

# 13. History Size

Do NOT maintain unlimited history.

Start with:

```typescript
MAX_SEGMENT_HISTORY = 3;
```

So JEV receives at most:

```text
previous utterance
previous utterance
previous utterance
NEW utterance
```

If the current language has been active for 10 minutes, still only send the latest 3 meaningful utterances.

This keeps latency and request size predictable.

---

# 14. Important: What Counts as an Utterance?

Do not send every tiny partial transcript to JEV.

For the first POC, wait until Gemini provides a reasonably complete user turn.

For example:

```text
User starts speaking...

"I need help with my payment"
              ↓
       complete utterance
              ↓
             JEV
```

Not:

```text
"I"
"I need"
"I need help"
"I need help with"
"I need help with my"
...
```

Otherwise you will create unnecessary JEV requests and unstable decisions.

---

# 15. Numbers and Short Utterances

The application can perform a very lightweight pre-filter before calling JEV.

Examples:

```text
21
500
₹500
OTP
yes
no
okay
sir
hello
```

These do not contain enough information to justify a language switch by themselves.

However, **do not build a giant rule-based language detector.**

JEV remains the primary decision-maker.

The pre-filter should only eliminate obvious non-language-bearing utterances and reduce unnecessary JEV calls.

---

# 16. Gemini System Prompt

Gemini should NOT independently decide when to change language.

Use a system prompt along these lines:

```text
You are a multilingual voice call assistant.

The conversation has a current confirmed language provided by the application.

The application has a separate language decision system.

The application's confirmed language is authoritative.

When the application says the current language is Tamil, respond naturally in Tamil.

When the application says the current language is English, respond naturally in English.

When the application says the current language is Hindi, respond naturally in Hindi.

Do not independently change the conversation language based on a single word, number, name, brand, amount, date, technical term, or acknowledgement.

Do not talk about language detection, JEV, language controllers, confidence scores, or internal system logic.

If the application changes the confirmed language, naturally continue the conversation in the new language.

The conversation should feel like a natural human phone conversation.

Do not announce that a language switch occurred.

Simply continue naturally in the confirmed language.
```

---

# 17. How Gemini Gets the New Language

When JEV decides:

```text
Tamil → English
```

the backend must update Gemini's conversational context/instructions.

Use whatever language/session update mechanism is supported by the current Gemini Live API.

Do not assume an obsolete API method.

At implementation time, check the current Gemini Live SDK documentation and use the currently supported mechanism.

The important logical operation is:

```text
LanguageState.currentLanguage
        ↓
Gemini session instructions
        ↓
Respond in English
```

---

# 18. Do Not Kill and Recreate the Gemini Session

The language switch should ideally happen inside the existing live session.

Avoid:

```text
Tamil
 ↓
destroy Gemini session
 ↓
create English Gemini session
```

unless the current Gemini API technically requires it.

Prefer:

```text
same Gemini Live session
        ↓
update confirmed language
        ↓
continue conversation
```

The goal is a seamless conversation.

---

# 19. Audio Behavior

Do not abruptly cut an already-playing Gemini response merely because JEV has changed the language.

Example:

```text
Gemini is currently speaking Tamil
        ↓
User interrupts / speaks English
        ↓
JEV decides English
        ↓
next Gemini response = English
```

The switch should apply to the **next response**.

If Gemini's current response has already started playing, don't create ugly audio artifacts just to force the language change.

---

# 20. Browser UI

Keep the UI extremely simple.

```text
--------------------------------

Gemini + JEV Language POC

[ Start Call ]

Status: Connected

Current language:
Tamil

Last JEV decision:
No switch

Debug log:

22:14:01
User: [Tamil transcript]
JEV: Tamil
Decision: No switch

22:14:08
User: I need help with my payment.
JEV: English
Decision: SWITCH
Language: Tamil → English

--------------------------------

[ Stop Call ]
```

That's enough.

Do NOT build:

* fancy animations
* login
* dashboard
* call history
* database
* charts
* settings pages
* authentication

---

# 21. Debug Logging

This is extremely important.

Log every JEV decision.

Example:

```text
[22:14:01]
Current: ta
User: "எனக்கு payment problem இருக்கு"
JEV: ta
Switch: false

[22:14:08]
Current: ta
User: "I need help with my payment."
JEV: en
Switch: true
New language: en

[22:14:15]
Current: en
User: "Can you check it?"
JEV: en
Switch: false

[22:14:24]
Current: en
User: "நேற்று அது fail ஆயிடுச்சு"
JEV: ta
Switch: true
New language: ta
```

Also log:

```text
JEV request start time
JEV response time
JEV latency
current language
new utterance
segment history size
JEV decision
language change
```

This is necessary because we need to determine whether this architecture is actually fast enough for calls.

---

# 22. Latency Measurement

Measure:

```text
T1 = user utterance complete
T2 = JEV request starts
T3 = JEV response received
T4 = language state updated
T5 = Gemini response starts
T6 = first audio returned
```

Calculate:

```text
JEV latency = T3 - T2

Decision latency = T4 - T1

Added conversational latency =
T6 - T1
```

Display JEV latency in the debug log.

Example:

```text
JEV latency: 143 ms
Language decision: 158 ms
```

We need this data before deciding whether JEV belongs in the production Exotel path.

---

# 23. Test Cases

The POC is successful only if these cases are tested.

## Test 1 — Tamil conversation

```text
Tamil
Tamil
Tamil
Tamil
```

Expected:

```text
No language switch.
```

---

## Test 2 — Tamil → English

```text
Tamil
Tamil
Tamil

"I need help with my payment."
```

Expected:

```text
Tamil → English
```

**One decision. No second confirmation.**

---

## Test 3 — English continuation

```text
"I need help with my payment."
"Can you check the status?"
"I paid yesterday."
```

Expected:

```text
English throughout.
```

---

## Test 4 — English → Tamil

```text
English
English
English

"நேற்று payment fail ஆயிடுச்சு."
```

Expected:

```text
English → Tamil
```

---

## Test 5 — Tamil → Hindi

```text
Tamil
Tamil

"मुझे अपने पेमेंट के बारे में मदद चाहिए।"
```

Expected:

```text
Tamil → Hindi
```

---

## Test 6 — Number

```text
Current language: Tamil

"21"
```

Expected:

```text
NO SWITCH
```

---

## Test 7 — Amount

```text
"500 ரூபாய்"
```

Expected:

```text
NO SWITCH
```

unless the overall utterance clearly establishes a new language.

---

## Test 8 — Name

```text
"My name is John."
```

Do not automatically assume the user has changed language if the surrounding conversation is Tamil.

---

## Test 9 — Single English word

```text
"Payment."
```

Expected:

```text
NO SWITCH
```

---

## Test 10 — Genuine English sentence

```text
"I need help with my payment."
```

Expected:

```text
SWITCH TO ENGLISH
```

---

## Test 11 — Code switching

```text
"என்னுடைய payment failed ஆயிடுச்சு."
```

This should generally remain Tamil if the overall conversational language is Tamil.

Do not treat every English word inside a Tamil sentence as a language switch.

---

## Test 12 — Explicit request

```text
"Please speak in English."
```

Expected:

```text
Immediate switch to English.
```

Likewise:

```text
"தமிழில் பேசுங்கள்."
```

Expected:

```text
Immediate switch to Tamil.
```

Explicit requests should be treated as very strong evidence.

---

# 24. Critical Experiment

The purpose of this POC is NOT simply:

> "Does JEV identify languages correctly?"

The real question is:

> **"Can JEV reliably identify genuine conversational language changes from normal code-switching and isolated foreign-language words, while adding little enough latency for a live voice call?"**

Track:

```text
Total language decisions
Correct switches
Missed switches
False switches
JEV latency
End-to-end added latency
```

Example test table:

| Test                  | Expected  | Actual | Correct? | JEV latency |
| --------------------- | --------- | ------ | -------- | ----------- |
| Tamil → Tamil         | No switch |        |          |             |
| Tamil → English       | Switch    |        |          |             |
| English → Tamil       | Switch    |        |          |             |
| Tamil + "payment"     | No switch |        |          |             |
| Tamil + "21"          | No switch |        |          |             |
| Tamil → Hindi         | Switch    |        |          |             |
| English name in Tamil | No switch |        |          |             |

---

# 25. Project Structure

Use something simple:

```text
jev-gemini-language-poc/

├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── VoiceControls.tsx
│   │   │   ├── LanguageStatus.tsx
│   │   │   └── DebugLog.tsx
│   │   │
│   │   ├── audio/
│   │   │   ├── microphone.ts
│   │   │   └── playback.ts
│   │   │
│   │   ├── App.tsx
│   │   └── main.tsx
│   │
│   └── package.json
│
├── server/
│   ├── src/
│   │   ├── gemini/
│   │   │   └── geminiLive.ts
│   │   │
│   │   ├── jev/
│   │   │   ├── jevClient.ts
│   │   │   └── jevPrompt.ts
│   │   │
│   │   ├── language/
│   │   │   ├── LanguageSwitchManager.ts
│   │   │   ├── languageState.ts
│   │   │   └── languageConfig.ts
│   │   │
│   │   ├── websocket/
│   │   │   └── websocketServer.ts
│   │   │
│   │   └── server.ts
│   │
│   └── package.json
│
├── .env.example
├── README.md
└── package.json
```

---

# 26. Environment Variables

Use:

```env
GEMINI_API_KEY=
GEMINI_MODEL=

JEV_API_KEY=
JEV_MODEL=

PORT=3001
```

Use the currently supported Gemini Live model and JEV configuration.

Do not hard-code API keys.

Do not expose either API key to the browser.

---

# 27. Security

The browser must communicate only with our Node backend.

```text
Browser
   ↓
Node backend
   ↓
Gemini
JEV
```

Never:

```text
Browser → Gemini API key
Browser → JEV API key
```

Both keys stay server-side.

---

# 28. WebSocket Events

Keep the protocol simple.

### Browser → Server

```json
{
  "type": "start_session"
}
```

Audio:

```json
{
  "type": "audio",
  "data": "..."
}
```

Stop:

```json
{
  "type": "stop_session"
}
```

### Server → Browser

Language:

```json
{
  "type": "language_changed",
  "language": "en"
}
```

Debug:

```json
{
  "type": "language_decision",
  "currentLanguage": "ta",
  "detectedLanguage": "en",
  "switched": true,
  "latencyMs": 142
}
```

Status:

```json
{
  "type": "status",
  "status": "connected"
}
```

Audio:

```json
{
  "type": "audio",
  "data": "..."
}
```

---

# 29. Start Language

For the POC:

```text
initialLanguage = Tamil
```

The agent starts in Tamil.

However:

> **Tamil is the initial language, not a permanent language constraint.**

The user can switch to:

```text
English
Hindi
Tamil
```

during the call.

---

# 30. Error Handling

If JEV fails:

```text
JEV timeout
JEV API error
invalid response
network failure
```

Do NOT terminate the call.

Fallback behavior:

```text
Keep current language.
Continue Gemini conversation.
Log JEV failure.
```

Example:

```text
JEV failed.
Keeping current language: Tamil.
```

The voice call must remain functional even if the language decision service temporarily fails.

---

# 31. JEV Timeout

Set a reasonable timeout.

Start with something like:

```text
JEV timeout = 500 ms
```

Make this configurable.

If JEV doesn't respond within the timeout:

```text
NO SWITCH
```

and continue the conversation in the current language.

Do not block the entire voice call indefinitely waiting for JEV.

---

# 32. Important Concurrency Rule

Multiple JEV requests should not create inconsistent language state.

For example:

```text
Utterance A → JEV
Utterance B → JEV
```

Do not allow B's decision to update the state before A if A was actually earlier.

Process utterances in order.

A simple sequential queue is acceptable for this POC.

---

# 33. Don't Overengineer

Do NOT create:

```text
Kafka
Redis
Postgres
message queues
microservices
Kubernetes
Docker
event buses
```

for this experiment.

A Node process + WebSocket + Gemini + JEV is enough.

---

# 34. What Claude Must Build

Claude Code should:

1. Create the React/Vite frontend.
2. Create the Node/TypeScript backend.
3. Implement browser microphone capture.
4. Implement Gemini Live connection.
5. Implement Gemini audio playback.
6. Implement transcript/event handling.
7. Implement JEV integration.
8. Implement the language-segment state manager.
9. Implement the JEV decision prompt.
10. Implement language switching.
11. Implement Gemini language-context updates.
12. Implement WebSocket communication.
13. Implement debug logging.
14. Implement latency measurements.
15. Implement all test cases.
16. Create a clear README.
17. Make the entire project runnable locally.

---

# 35. Do Not Fake the Integrations

If the current Gemini Live SDK or JEV SDK has changed:

**Stop and inspect the current official documentation/API before implementing that portion.**

Do not invent:

```text
SDK methods
API endpoints
JEV request formats
Gemini Live methods
model names
response schemas
```

Use the currently supported APIs.

Create small adapter files:

```text
geminiLive.ts
jevClient.ts
```

so API-specific implementation stays isolated.

---

# 36. Definition of Done

The POC is complete when I can run:

```bash
npm install
npm run dev
```

and open the browser.

I should see:

```text
Gemini + JEV Language Switching POC

[Start Call]

Status: Connected

Current Language: Tamil

Debug Log
```

Then I can speak into my microphone.

The agent responds naturally.

If I speak Tamil:

```text
Tamil → Tamil
```

If I suddenly speak a meaningful English sentence:

```text
Tamil → English
```

**on the first valid English utterance.**

If I then speak Hindi:

```text
English → Hindi
```

again on the first valid Hindi utterance.

If I say:

```text
21
```

the agent must NOT suddenly switch languages.

If I say:

```text
payment
OTP
John
500
yes
okay
```

the agent must not randomly switch languages.

The debug console must show:

```text
utterance
current language
JEV decision
switch/no-switch
new language
JEV latency
```

---

# 37. Final Architecture to Implement

The final POC should effectively behave like this:

```text
                    ┌───────────────┐
                    │    USER       │
                    │    SPEECH     │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ GEMINI LIVE   │
                    │     STT       │
                    └───────┬───────┘
                            │
                      completed
                       utterance
                            │
                            ▼
             ┌──────────────────────────┐
             │   LANGUAGE MANAGER       │
             │                          │
             │ Current language         │
             │ Current segment history  │
             └────────────┬─────────────┘
                          │
                          ▼
                    ┌───────────┐
                    │    JEV    │
                    │           │
                    │ Has the   │
                    │ user      │
                    │ switched  │
                    │ language? │
                    └─────┬─────┘
                          │
                ┌─────────┴─────────┐
                │                   │
              NO                  YES
                │                   │
                ▼                   ▼
        Keep language        Change language
                │                   │
                │            Reset segment
                │               history
                │                   │
                └─────────┬─────────┘
                          │
                          ▼
                    ┌───────────────┐
                    │ GEMINI LIVE   │
                    │               │
                    │ Respond in    │
                    │ confirmed     │
                    │ language      │
                    └───────┬───────┘
                            │
                            ▼
                         AUDIO
                            │
                            ▼
                           USER
```

## Core principle

**Gemini should not decide the language. JEV should not manage the conversation. Your application owns the language state.**

```text
Gemini → "What did the user say?"

JEV → "Did the user change languages?"

Application → "Okay, the confirmed language is now X."

Gemini → "Respond naturally in X."
```

Build this **as the smallest working browser POC first**. Once this proves that JEV can make the language-switch decision accurately and quickly enough, the exact same `LanguageSwitchManager` can later be placed into the **Exotel + AWS production call pipeline**.
