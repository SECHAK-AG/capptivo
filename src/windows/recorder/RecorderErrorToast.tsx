/**
 * Error banner — fixed above the dock so it is never clipped by the recorder
 * webview's overflow or the compact HUD/countdown layouts.
 */

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useRecorderStore } from "./store";

const DISMISS_MS = 6000;
/** Sit above the dock + recorder bar (bar ~56px + margin). */
const TOAST_BOTTOM_PX = 88;

const TOAST_SURFACE: React.CSSProperties = {
  background: "#dc2626",
  color: "#fff",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.45)",
};

/** Wrap the recorder pill; error toast is viewport-fixed, not in this flow. */
export function RecorderBarAnchor({ children }: { children: ReactNode }) {
  return (
    <>
      <RecorderErrorToast />
      <div className="flex w-fit flex-col items-center">{children}</div>
    </>
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
      style={{ ...TOAST_SURFACE, bottom: TOAST_BOTTOM_PX }}
      className={cn(
        "pointer-events-auto fixed left-1/2 z-[9999] flex w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg px-3 py-2 text-xs font-medium leading-snug",
        className,
      )}
    >
      <p className="min-w-0 flex-1 break-words">{error}</p>
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
