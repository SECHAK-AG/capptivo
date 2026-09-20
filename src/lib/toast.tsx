import toast, { Toaster } from "react-hot-toast";

const TOAST_STYLE: React.CSSProperties = {
  background: "oklch(0.45 0.18 25)",
  color: "#fff",
  fontSize: "14px",
  fontWeight: 500,
  padding: "12px 16px",
  borderRadius: "10px",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.45)",
  maxWidth: "min(420px, calc(100vw - 32px))",
};

/** Surface a user-visible error without coupling callers to the toast library. */
export function showError(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  toast.error(trimmed, {
    duration: 6000,
    style: TOAST_STYLE,
  });
}

/** Non-fatal heads-up (e.g. dropped frames): amber, same shape as errors. */
export function showWarning(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  toast(trimmed, {
    duration: 8000,
    icon: "⚠️",
    style: { ...TOAST_STYLE, background: "oklch(0.55 0.15 75)" },
  });
}

export function AppToaster() {
  return (
    <Toaster
      position="top-center"
      containerStyle={{ zIndex: 100_000, top: 40 }}
      toastOptions={{
        style: TOAST_STYLE,
      }}
    />
  );
}
