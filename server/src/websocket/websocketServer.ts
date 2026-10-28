import type { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { GeminiLiveAdapter } from "../gemini/geminiLive.js";
import { startJevKeepAlive } from "../jev/jevClient.js";
import { AUDIO_HOLD_MS, POST_SWITCH_SQUELCH_MS } from "../language/languageConfig.js";
import { LanguageSwitchManager } from "../language/LanguageSwitchManager.js";
import { createInitialLanguageState } from "../language/languageState.js";

type ClientMessage =
  | { type: "start_session" }
  | { type: "audio"; data: string }
  | { type: "stop_session" };

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    let gemini: GeminiLiveAdapter | null = null;
    let manager: LanguageSwitchManager | null = null;

    // Approximate "added conversational latency" (context.md section 22):
    // time from a confirmed language switch to the first audio chunk that
    // follows it.
    let waitingForPostSwitchAudio = false;
    let switchAppliedAt = 0;
    let stopKeepAlive: (() => void) | null = null;

    // Held audio for the turn currently awaiting a JEV decision - see
    // AUDIO_HOLD_MS in languageConfig.ts for why this exists. null means
    // "not holding, forward chunks as they arrive" (the normal state).
    let audioHold: string[] | null = null;
    let audioHoldTimer: ReturnType<typeof setTimeout> | null = null;

    // Timestamp until which incoming audio chunks are dropped outright - see
    // POST_SWITCH_SQUELCH_MS in languageConfig.ts.
    let squelchUntil = 0;

    const forwardAudio = (data: string) => {
      if (waitingForPostSwitchAudio) {
        waitingForPostSwitchAudio = false;
        send(ws, {
          type: "debug_log",
          event: "first_audio_after_switch",
          latencyMs: Date.now() - switchAppliedAt,
        });
      }
      send(ws, { type: "audio", data });
    };

    const releaseAudioHold = () => {
      if (audioHoldTimer) {
        clearTimeout(audioHoldTimer);
        audioHoldTimer = null;
      }
      if (!audioHold) return;
      const buffered = audioHold;
      audioHold = null;
      for (const data of buffered) forwardAudio(data);
    };

    const discardAudioHold = () => {
      if (audioHoldTimer) {
        clearTimeout(audioHoldTimer);
        audioHoldTimer = null;
      }
      audioHold = null;
    };

    const startSession = async () => {
      manager = new LanguageSwitchManager(createInitialLanguageState());
      stopKeepAlive?.();
      stopKeepAlive = startJevKeepAlive();

      gemini = new GeminiLiveAdapter({
        onAudioChunk: (data) => {
          if (Date.now() < squelchUntil) return;
          if (audioHold) {
            audioHold.push(data);
            return;
          }
          forwardAudio(data);
        },
        onInputUtteranceComplete: async (text) => {
          if (!manager || !gemini) return;

          // Defensively flush any stale hold before starting a new one -
          // shouldn't normally happen since utterances are processed one at
          // a time, but better to release audio late than lose it.
          releaseAudioHold();
          audioHold = [];
          audioHoldTimer = setTimeout(releaseAudioHold, AUDIO_HOLD_MS);

          const result = await manager.processUtterance(text);

          send(ws, {
            type: "language_decision",
            currentLanguage: result.state.currentLanguage,
            detectedLanguage: result.decision.newLanguage ?? result.state.currentLanguage,
            switched: result.decision.languageChanged,
          });

          send(ws, {
            type: "debug_log",
            event: "jev_decision",
            utterance: text,
            currentLanguage: result.state.currentLanguage,
            switched: result.decision.languageChanged,
            newLanguage: result.decision.newLanguage,
            confidence: result.decision.confidence,
            reason: result.decision.reason,
            skippedJev: result.timings.skippedJev,
            jevLatencyMs: result.timings.jevLatencyMs,
            decisionLatencyMs: result.timings.decisionLatencyMs,
          });

          if (result.decision.languageChanged && result.decision.newLanguage) {
            // Whatever we held was generated before the switch was known -
            // it's in the old language (or about to be interrupted anyway),
            // so it gets discarded rather than played.
            discardAudioHold();
            gemini.setLanguage(result.decision.newLanguage);
            switchAppliedAt = Date.now();
            squelchUntil = switchAppliedAt + POST_SWITCH_SQUELCH_MS;
            waitingForPostSwitchAudio = true;
            send(ws, { type: "language_changed", language: result.decision.newLanguage });
          } else {
            releaseAudioHold();
          }
        },
        onError: (message) => {
          send(ws, { type: "debug_log", event: "gemini_error", message });
        },
        onClose: (reason) => {
          send(ws, { type: "debug_log", event: "gemini_closed", message: reason });
          send(ws, { type: "status", status: "idle" });
        },
      });

      try {
        const initialLanguage = manager.getState().currentLanguage;
        await gemini.connect(initialLanguage);
        send(ws, { type: "status", status: "connected" });
        send(ws, { type: "language_changed", language: initialLanguage });
      } catch (err) {
        send(ws, { type: "status", status: "error" });
        send(ws, {
          type: "debug_log",
          event: "gemini_connect_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const stopSession = () => {
      stopKeepAlive?.();
      stopKeepAlive = null;
      discardAudioHold();
      gemini?.close();
      gemini = null;
      manager = null;
      send(ws, { type: "status", status: "idle" });
    };

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "start_session") {
        void startSession();
      } else if (msg.type === "audio") {
        gemini?.sendAudioChunk(msg.data);
      } else if (msg.type === "stop_session") {
        stopSession();
      }
    });

    ws.on("close", () => {
      stopKeepAlive?.();
      stopKeepAlive = null;
      discardAudioHold();
      gemini?.close();
      gemini = null;
      manager = null;
    });
  });

  return wss;
}
