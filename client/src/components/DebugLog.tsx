export interface DebugEntry {
  time: string;
  text: string;
}

export function DebugLog({ entries }: { entries: DebugEntry[] }) {
  return (
    <div>
      <h4>Debug log</h4>
      <div
        style={{
          height: 320,
          overflowY: "auto",
          background: "#111",
          color: "#0f0",
          padding: 8,
          fontFamily: "monospace",
          fontSize: 12,
          whiteSpace: "pre-wrap",
        }}
      >
        {entries.length === 0 && <div style={{ color: "#666" }}>(no events yet)</div>}
        {entries.map((entry, i) => (
          <div key={i}>
            {entry.time} — {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}
