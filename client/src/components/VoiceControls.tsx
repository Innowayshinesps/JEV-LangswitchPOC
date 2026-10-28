export type CallStatus = "idle" | "connecting" | "connected" | "error";

interface Props {
  status: CallStatus;
  onToggle: () => void;
}

export function VoiceControls({ status, onToggle }: Props) {
  const isActive = status === "connecting" || status === "connected";

  return (
    <div style={{ marginBottom: 16 }}>
      <button onClick={onToggle} style={{ fontSize: 16, padding: "8px 20px", cursor: "pointer" }}>
        {isActive ? "Stop Call" : "Start Call"}
      </button>
      <span style={{ marginLeft: 12 }}>Status: {status}</span>
    </div>
  );
}
