interface Props {
  currentLanguage: string;
  lastDecision: string;
}

export function LanguageStatus({ currentLanguage, lastDecision }: Props) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div>
        Current language: <strong>{currentLanguage}</strong>
      </div>
      <div>Last JEV decision: {lastDecision}</div>
    </div>
  );
}
