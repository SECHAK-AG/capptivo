/** 3-2-1 countdown — fixed square badge (never stretches with window). */

import { useEffect, useState } from "react";

/** Must match `LAYOUT_COUNTDOWN` in windows.rs */
const BADGE_PX = 240;

export function Countdown({ from = 3, onDone }: { from?: number; onDone: () => void }) {
  const [n, setN] = useState(from);

  useEffect(() => {
    if (n <= 0) {
      onDone();
      return;
    }
    const timer = window.setTimeout(() => setN((v) => v - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [n, onDone]);

  if (n <= 0) return null;

  return (
    <div className="grid h-full w-full place-items-center bg-transparent">
      <div
        className="relative overflow-hidden bg-neutral-950/90"
        style={{
          width: BADGE_PX,
          height: BADGE_PX,
          borderRadius: BADGE_PX * 0.18,
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 46%, rgba(255,255,255,0.26) 0%, rgba(255,255,255,0.08) 32%, transparent 64%)",
          }}
        />
        <div className="relative z-10 grid h-full w-full place-items-center">
          <span
            key={n}
            className="leading-none font-semibold tracking-tight text-white tabular-nums animate-in zoom-in-95 fade-in duration-200"
            style={{ fontSize: BADGE_PX * 0.48 }}
          >
            {n}
          </span>
        </div>
      </div>
    </div>
  );
}
