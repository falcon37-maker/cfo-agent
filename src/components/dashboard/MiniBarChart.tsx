type Bar = { value: number; neg?: boolean };

export function MiniBarChart({
  bars,
  width = 60,
  height = 24,
}: {
  bars: Bar[];
  width?: number;
  height?: number;
}) {
  if (bars.length === 0) return null;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const gap = 2;
  const barW = Math.max(2, (width - gap * (bars.length - 1)) / bars.length);

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {bars.map((b, i) => {
        const h = (b.value / max) * height;
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={1.5}
            fill={b.neg ? "var(--negative)" : "var(--accent)"}
            opacity={b.neg ? 0.75 : 0.85}
          />
        );
      })}
    </svg>
  );
}
