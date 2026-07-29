import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/settings";
import { cancelActiveExport } from "../export/exportVideo";
import { useEditorStore } from "../store";

/** Lightweight progress card while encoding — Save dialog opens only after render. */
export function ExportProgressOverlay() {
  const { t } = useI18n();
  const exporting = useEditorStore((s) => s.exporting);
  const progress = useEditorStore((s) => s.exportProgress);
  const status = useEditorStore((s) => s.exportStatus);

  if (!exporting) return null;

  const pct = Math.round(progress * 100);

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-start justify-end p-4">
      <div className="pointer-events-auto w-full max-w-sm rounded-xl border border-border bg-card/95 p-4 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            {t("export.progressTitle")}
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {status ?? t("export.rendering")}
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          onClick={() => cancelActiveExport()}
        >
          {t("export.cancel")}
        </Button>
      </div>
    </div>
  );
}
