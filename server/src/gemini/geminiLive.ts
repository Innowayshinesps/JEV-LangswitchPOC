import { GoogleGenAI, LiveServerMessage, Modality, Session } from "@google/genai";
import { GEMINI_MODEL, LanguageCode, SUPPORTED_LANGUAGES } from "../language/languageConfig.js";

// context.md section 16, extended with the [LANGUAGE: xx] tag protocol used
// by setLanguage() below. Gemini's systemInstruction cannot be changed once
// the Live session is open (confirmed against the current API docs), so the
// language switch is communicated via a steering note inside the live
// session instead of recreating the session (section 18/19).
const BASE_SYSTEM_INSTRUCTION = `
You are a multilingual voice call assistant working as the front-desk
receptionist for a hospital. Callers phone in to book, reschedule, or cancel
doctor appointments, ask which departments or specialists are available, ask
about visiting hours, or leave their details for a callback. Be warm, brief,
and efficient, the way a real phone receptionist would be - short sentences,
natural acknowledgements, and one question at a time. When booking an
appointment, gather what's actually needed (name, reason/department,
preferred date and time, contact number) through natural conversation rather
than a rigid script. You do not have access to a real scheduling system in
this call, so when a caller asks to confirm a specific slot, acknowledge it
naturally and say it will be confirmed, rather than inventing doctor names,
exact availability, or hospital policies you don't actually know.

The conversation has a current confirmed language, provided by the application.
The application has a separate language decision system. The application's
confirmed language is authoritative.

The application communicates the confirmed language with a note formatted
exactly as: [LANGUAGE: <code>] followed by an instruction. <code> is one of:
${Object.keys(SUPPORTED_LANGUAGES).join(", ")}.
Always obey the most recently received [LANGUAGE: <code>] note and respond in
that language (${Object.entries(SUPPORTED_LANGUAGES)
  .map(([code, name]) => `${code} = ${name}`)
  .join(", ")}) from that point onward, until a new note changes it.

Never read the [LANGUAGE: ...] note aloud, and never talk about language
detection, JEV, language controllers, confidence scores, or internal system
logic.

Do not independently change the conversation language based on a single
word, number, name, brand, amount, date, technical term, or acknowledgement.

If the application changes the confirmed language, naturally continue the
conversation in the new language. Do not announce that a switch occurred.
The conversation should feel like a natural human phone conversation.
`;

export interface GeminiLiveCallbacks {
  onAudioChunk: (base64Audio: string) => void;
  onInputUtteranceComplete: (text: string) => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
}

export class GeminiLiveAdapter {
  private ai: GoogleGenAI;
  private session: Session | null = null;
  private pendingInputTranscript = "";
  private flushedForTurn = false;

  constructor(private callbacks: GeminiLiveCallbacks) {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async connect(initialLanguage: LanguageCode): Promise<void> {
    this.session = await this.ai.live.connect({
      model: GEMINI_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        // Tried hinting this toward exactly our 3 supported languages
        // (languageCodes: ["ta-IN","en-IN","hi-IN"]) to fix Tamil speech
        // occasionally being transcribed in Devanagari (Hindi script) as
        // near-nonsense text. Two more rounds of live testing kept showing
        // mis-transcription into Hindi anyway - including a new failure
        // shape (a plainly English phrase transcribed entirely in
        // Devanagari) that the hint plausibly made *more* likely, since it
        // makes hi-IN an actively weighted candidate instead of leaving
        // detection unconstrained. Reverted to plain auto-detect as an
        // experiment; no confirmed evidence either version is reliably
        // better for this speaker's heavy three-way code-switching.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: BASE_SYSTEM_INSTRUCTION,
      },
      callbacks: {
        onopen: () => {},
        onmessage: (message: LiveServerMessage) => this.handleMessage(message),
        onerror: (event: { message?: string; error?: unknown }) => {
          const message = event.message ?? String(event.error ?? event);
          console.error("[geminiLive] error:", message);
          this.callbacks.onError(message);
        },
        onclose: (event: { code?: number; reason?: string }) => {
          console.error("[geminiLive] closed:", event.code, event.reason);
          this.callbacks.onClose(event.reason || `code ${event.code ?? "unknown"}`);
        },
      },
    });

    // Non-interrupting: no user speech has happened yet, so there's nothing
    // to interrupt, and forcing a reply here would make Gemini speak
    // unprompted before the caller has said anything.
    this.sendLanguageNote(initialLanguage, false);
  }

  private handleMessage(message: LiveServerMessage): void {
    const content = message.serverContent;
    if (!content) return;

    if (content.inputTranscription?.text) {
      this.pendingInputTranscript += content.inputTranscription.text;
    }

    // Per the Live API docs, inputTranscription for a user turn arrives
    // before the model's audio parts start streaming for that turn - so the
    // first modelTurn part is our earliest reliable signal that the user's
    // utterance is finalized (see plan notes on turnComplete vs input end).
    if (content.modelTurn?.parts) {
      this.flushInputTranscript();
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.callbacks.onAudioChunk(part.inlineData.data);
        }
      }
    }

    if (content.turnComplete) {
      this.flushInputTranscript();
      this.flushedForTurn = false;
    }
  }

  private flushInputTranscript(): void {
    if (this.flushedForTurn) return;
    const text = this.pendingInputTranscript.trim();
    this.pendingInputTranscript = "";
    if (text.length > 0) {
      this.flushedForTurn = true;
      this.callbacks.onInputUtteranceComplete(text);
    }
  }

  sendAudioChunk(base64Pcm16: string): void {
    this.session?.sendRealtimeInput({
      audio: { data: base64Pcm16, mimeType: "audio/pcm;rate=16000" },
    });
  }

  // Called when JEV confirms a genuine language switch. Always sends with
  // turnComplete: true (interrupting per the Live API docs, "will interrupt
  // any current model generation"): the user's utterance and its transcript
  // are already fully in Gemini's context by the time this is called, so
  // this doesn't cut the user off - it cuts off Gemini's own in-progress or
  // about-to-start reply in the OLD language, which is exactly the point.
  // Without this, testing showed the switch only took effect one exchange
  // late: Gemini's own response generation reliably starts faster than our
  // JEV round trip, so a non-interrupting note just gets queued behind
  // whatever Gemini was already about to say.
  setLanguage(code: LanguageCode): void {
    this.sendLanguageNote(code, true);
  }

  private sendLanguageNote(code: LanguageCode, interrupt: boolean): void {
    // Tried adding "Respond now, briefly." here to nudge Gemini toward a
    // shorter, faster first reply after an interrupt. Live testing showed
    // it made both latency (~800ms -> ~1050-1260ms) and audio quality (a
    // new stutter/"jerk" right at the start of the reply) worse, not
    // better - reverted. Left as a note so this isn't retried blind.
    //
    // Just the tag, not a full sentence: BASE_SYSTEM_INSTRUCTION already
    // explains the [LANGUAGE: <code>] protocol once, in full, at connect
    // time - repeating "Continue naturally in <language name>. Do not
    // mention this note." on every single switch means a long call with
    // many switches accumulates many fake "user" turns each naming a
    // language, which is exactly the kind of context noise that could
    // plausibly degrade the session's own STT language disambiguation over
    // time (transcription was observed working fine early in a call, then
    // degrading later in the same call). Keeping this minimal reduces that
    // noise regardless of whether it's the actual cause.
    const note = `[LANGUAGE: ${code}]`;
    this.session?.sendClientContent({
      turns: [{ role: "user", parts: [{ text: note }] }],
      turnComplete: interrupt,
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
