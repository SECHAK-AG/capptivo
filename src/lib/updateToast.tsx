/**
 * Cursor-style bottom-right update card — editor / library shells only.
 * Portaled to `document.body` so `#root > div { min-height: 100% }` can't
 * stretch it into a full-height sidebar. Installing UI mirrors export's
 * linear progress bar (real download bytes only — never a fake %).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { commands } from "@/ipc/bindings";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type UpdateAvailablePayload = {
  version: string;
  currentVersion: string;
  notes: string;
};

export type UpdateStatusPayload =
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "installing"; version: string }
  | { kind: "progress"; downloaded: number; total: number | null }
  | { kind: "error"; message: string }
  | { kind: "busyRecording" };

type Panel =
  | { mode: "available"; payload: UpdateAvailablePayload }
  | {
      mode: "installing";
      version: string;
      /** 0–1 when Content-Length is known; otherwise indeterminate. */
      progress: number | null;
    };

const STATUS_STYLE: React.CSSProperties = {
  background: "var(--card)",
  color: "var(--card-foreground)",
  fontSize: "13px",
  fontWeight: 500,
  padding: "10px 14px",
  borderRadius: "10px",
  border: "1px solid var(--border)",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
  maxWidth: "min(360px, calc(100vw - 32px))",
};

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function showStatusToast(t: Translate, status: UpdateStatusPayload) {
  const base = {
    id: "updater-status",
    position: "bottom-right" as const,
    style: STATUS_STYLE,
  };

  if (status.kind === "checking") {
    toast(t("updater.checking"), { ...base, duration: 2500 });
    return;
  }
  if (status.kind === "upToDate") {
    toast.success(t("updater.upToDate"), { ...base, duration: 4000 });
    return;
  }
  if (status.kind === "busyRecording") {
    toast.error(t("updater.busyRecording"), { ...base, duration: 5000 });
    return;
  }
  if (status.kind === "error") {
    toast.error(status.message || t("updater.error"), { ...base, duration: 6000 });
  }
}

function fractionFromProgress(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(1, Math.max(0, downloaded / total));
}

/** Same track + fill language as `ExportProgressOverlay`. */
function UpdateProgressBar({ progress }: { progress: number | null }) {
  if (progress == null) {
    return (
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="updater-indeterminate h-full w-1/3 rounded-full bg-primary" />
      </div>
    );
  }
  const pct = Math.round(progress * 100);
  return (
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function UpdateCard({
  panel,
  onLater,
  onInstall,
  onCloseInstall,
  t,
}: {
  panel: Panel;
  onLater: () => void;
  onInstall: () => void;
  onCloseInstall: () => void;
  t: Translate;
}) {
  const installing = panel.mode === "installing";

  return createPortal(
    <div
      className={cn(
        "fixed right-5 bottom-5 z-[100001] w-full max-w-sm rounded-xl border border-border",
        "bg-card/95 p-4 text-card-foreground shadow-xl backdrop-blur",
      )}
      role="status"
      aria-live="polite"
    >
      {installing ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("updater.installing")}
                </h2>
                {panel.progress != null ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {Math.round(panel.progress * 100)}%
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("updater.installing.detail", { version: panel.version })}
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseInstall}
              className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t("updater.dismiss")}
              title={t("updater.dismiss")}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <UpdateProgressBar progress={panel.progress} />
        </>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-foreground">
            {t("updater.available.title")}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("updater.available.detail", {
              version: panel.payload.version,
              current: panel.payload.currentVersion,
            })}
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onLater}
              className="h-8 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t("updater.later")}
            </button>
            <button
              type="button"
              onClick={onInstall}
              className="h-8 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              {t("updater.install")}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** Mount once in the editor shell (library + project). */
export function UpdateNotifier() {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [panel, setPanel] = useState<Panel | null>(null);

  useEffect(() => {
    let alive = true;

    const showAvailable = (payload: UpdateAvailablePayload) => {
      if (alive) setPanel({ mode: "available", payload });
    };

    void commands.pendingUpdate().then((pending) => {
      if (alive && pending) showAvailable(pending);
    });

    const unAvailable = listen<UpdateAvailablePayload>("updater://available", (e) => {
      if (alive && e.payload?.version) showAvailable(e.payload);
    });
    const unStatus = listen<UpdateStatusPayload>("updater://status", (e) => {
      if (!alive || !e.payload?.kind) return;
      const status = e.payload;
      if (status.kind === "installing") {
        setPanel({ mode: "installing", version: status.version, progress: null });
        return;
      }
      if (status.kind === "progress") {
        const progress = fractionFromProgress(status.downloaded, status.total);
        setPanel((prev) =>
          prev?.mode === "installing"
            ? { ...prev, progress }
            : prev,
        );
        return;
      }
      if (status.kind === "busyRecording" || status.kind === "error") {
        showStatusToast(tRef.current, status);
        void commands.pendingUpdate().then((pending) => {
          if (alive && pending) showAvailable(pending);
        });
        return;
      }
      showStatusToast(tRef.current, status);
    });

    return () => {
      alive = false;
      void unAvailable.then((fn) => fn());
      void unStatus.then((fn) => fn());
    };
  }, []);

  if (!panel) return null;

  return (
    <UpdateCard
      panel={panel}
      t={t}
      onLater={() => {
        setPanel(null);
        void commands.dismissUpdate();
      }}
      onCloseInstall={() => {
        setPanel(null);
        void commands.cancelInstall();
      }}
      onInstall={() => {
        const version =
          panel.mode === "installing" ? panel.version : panel.payload.version;
        setPanel({ mode: "installing", version, progress: null });
        void commands.installUpdate();
      }}
    />
  );
}
