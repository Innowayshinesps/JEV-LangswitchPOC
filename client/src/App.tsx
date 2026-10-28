import { useCallback, useRef, useState } from "react";
import { VoiceControls, CallStatus } from "./components/VoiceControls";
import { LanguageStatus } from "./components/LanguageStatus";
import { DebugLog, DebugEntry } from "./components/DebugLog";
import { startMicrophoneCapture, MicrophoneHandle } from "./audio/microphone";
import { AudioPlaybackQueue } from "./audio/playback";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";

// Kept in sync with server/src/language/languageConfig.ts's SUPPORTED_LANGUAGES.
const LANGUAGE_NAMES: Record<string, string> = { ta: "Tamil", en: "English", hi: "Hindi" };

function languageLabel(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export default function App() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [currentLanguage, setCurrentLanguage] = useState("ta");
  const [lastDecision, setLastDecision] = useState("No switch yet");
  const [log, setLog] = useState<DebugEntry[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicrophoneHandle | null>(null);
  const playbackRef = useRef<AudioPlaybackQueue | null>(null);

  const appendLog = useCallback((text: string) => {
    setLog((prev) => [...prev.slice(-199), { time: new Date().toLocaleTimeString(), text }]);
  }, []);

  const teardown = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    playbackRef.current?.close();
    playbackRef.current = null;
    wsRef.current = null;
  }, []);

  const stopCall = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop_session" }));
      ws.close();
    }
    teardown();
    setStatus("idle");
  }, [teardown]);

  const startCall = useCallback(() => {
    setStatus("connecting");
    setLog([]);
    setLastDecision("No switch yet");

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    playbackRef.current = new AudioPlaybackQueue();

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start_session" }));
      startMicrophoneCapture((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", data }));
        }
      })
        .then((handle) => {
          micRef.current = handle;
        })
        .catch((err: Error) => {
          appendLog(`Microphone error: ${err.message}`);
          stopCall();
        });
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "status": {
          if (msg.status === "connected") setStatus("connected");
          else if (msg.status === "error") setStatus("error");
          else if (msg.status === "idle") setStatus((s) => (s === "idle" ? s : "idle"));
          break;
        }
        case "audio": {
          playbackRef.current?.enqueue(msg.data);
          break;
        }
        case "language_changed": {
          setCurrentLanguage(msg.language);
          // Drop any already-buffered old-language audio instead of letting
          // it play out before the new-language reply arrives.
          playbackRef.current?.flush();
          break;
        }
        case "language_decision": {
          setLastDecision(msg.switched ? `SWITCH → ${languageLabel(msg.detectedLanguage)}` : "No switch");
          break;
        }
        case "debug_log": {
          if (msg.event === "jev_decision") {
            appendLog(
              `User: "${msg.utterance}" | current: ${msg.currentLanguage} | ${
                msg.switched ? `SWITCH → ${msg.newLanguage}` : "no switch"
              }` +
                (msg.skippedJev
                  ? " | (prefiltered, JEV skipped)"
                  : ` | JEV latency: ${msg.jevLatencyMs}ms | decision latency: ${msg.decisionLatencyMs}ms`) +
                (msg.reason ? ` | ${msg.reason}` : "")
            );
          } else if (msg.event === "first_audio_after_switch") {
            appendLog(`First audio after switch: ${msg.latencyMs}ms`);
          } else if (msg.event === "gemini_error") {
            appendLog(`Gemini error: ${msg.message}`);
          } else if (msg.event === "gemini_connect_error") {
            appendLog(`Gemini connect failed: ${msg.message}`);
          } else if (msg.event === "gemini_closed") {
            appendLog(`Gemini session closed: ${msg.message}`);
          }
          break;
        }
      }
    };

    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      teardown();
      setStatus((s) => (s === "idle" ? s : "idle"));
    };
  }, [appendLog, stopCall, teardown]);

  const toggleCall = useCallback(() => {
    if (status === "idle" || status === "error") {
      startCall();
    } else {
      stopCall();
    }
  }, [status, startCall, stopCall]);

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "40px auto", padding: 16 }}>
      <h2>Gemini + JEV Language POC</h2>
      <VoiceControls status={status} onToggle={toggleCall} />
      <LanguageStatus currentLanguage={languageLabel(currentLanguage)} lastDecision={lastDecision} />
      <DebugLog entries={log} />
    </div>
  );
}
