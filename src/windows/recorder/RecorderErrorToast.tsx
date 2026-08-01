/**
 * Error banner pinned to the recording bar — centered in the flex column,
 * directly above the pill (or below when the bar is near the top).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useRecorderStore } from "./store";

const TOAST_RESERVE_PX = 80;
const DISMISS_MS = 6000;

const TOAST_SURFACE: React.CSSProperties = {
  background: "#dc2626",
  color: "#fff",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.45)",
};

/** Wrap the recorder pill; the error banner stacks above/below in normal flow. */
export function RecorderBarAnchor({ children }: { children: ReactNode }) {
  const barRef = useRef<HTMLDivElement>(null);
  const error = useRecorderStore((s) => s.lastError);
  const [below, setBelow] = useState(false);

  useEffect(() => {
    if (!error?.trim()) return;

    const measure = () => {
      const el = barRef.current;
      if (!el) return;
      setBelow(el.getBoundingClientRect().top < TOAST_RESERVE_PX);
    };

    measure();
    const ro = new ResizeObserver(measure);
    if (barRef.current) ro.observe(barRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [error]);

  const show = Boolean(error?.trim());

  return (
    <div ref={barRef} className="flex w-fit flex-col items-center">
      {show && !below ? <RecorderErrorToast className="mb-2" /> : null}
      {children}
      {show && below ? <RecorderErrorToast className="mt-2" /> : null}
    </div>
  );
}

export function RecorderErrorToast({ className }: { className?: string }) {
  const { t } = useI18n();
  const error = useRecorderStore((s) => s.lastError);
  const clear = () => useRecorderStore.setState({ lastError: null });

  useEffect(() => {
    if (!error?.trim()) return;
    const id = window.setTimeout(clear, DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [error]);

  if (!error?.trim()) return null;

  return (
    <div
      role="alert"
      style={TOAST_SURFACE}
      className={cn(
        "pointer-events-auto z-50 flex w-max max-w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-lg px-3 py-2 text-xs font-medium leading-snug",
        className,
      )}
    >
      <p className="min-w-0 flex-1">{error}</p>
      <button
        type="button"
        aria-label={t("recorder.error.dismiss")}
        onClick={clear}
        className="shrink-0 rounded-md p-0.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
