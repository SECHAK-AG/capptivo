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

const INFO_TOAST_STYLE: React.CSSProperties = {
  ...TOAST_STYLE,
  background: "oklch(0.28 0.02 260)",
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

export function showInfo(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  toast(trimmed, {
    duration: 4000,
    style: INFO_TOAST_STYLE,
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
