"use client";

import { useEffect, useState } from "react";

export function Greeting({ name }: { name: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const hour = now?.getHours() ?? 10;
  const greeting =
    hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div>
      <div className="greet-eyebrow">Dashboard</div>
      <h1 className="greet-title">
        {greeting}, {name}
        <span className="greet-meta">
          {now
            ? ` · ${weekday(now)}, ${monthDay(now)} · ${hhmm(now)} UTC`
            : null}
        </span>
      </h1>
    </div>
  );
}

function weekday(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d);
}
function monthDay(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}
function hhmm(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
