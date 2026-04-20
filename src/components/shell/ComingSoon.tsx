export function ComingSoon({
  phase,
  needs,
}: {
  phase: string;
  needs: string[];
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "32px",
        color: "var(--text-dim)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: 8,
        }}
      >
        {phase}
      </div>
      <div
        style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}
      >
        Coming soon
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 560 }}>
        Needs these integrations first:
      </div>
      <ul
        style={{
          marginTop: 8,
          paddingLeft: 18,
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        {needs.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
