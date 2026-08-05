import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/settings";
import { cancelActiveExport } from "../export/exportVideo";
import { useEditorStore } from "../store";

/**
 * Blocking export dialog — preview/timeline stay inert until Cancel or finish.
 * Dismissible only via Cancel (no X, no outside click, no Escape).
 */
export function ExportProgressOverlay() {
  const { t } = useI18n();
  const exporting = useEditorStore((s) => s.exporting);
  const progress = useEditorStore((s) => s.exportProgress);
  const status = useEditorStore((s) => s.exportStatus);

  const pct = Math.round(progress * 100);

  return (
    <Dialog open={exporting}>
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-md"
      >
        <div className="relative px-6 pt-7 pb-6">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b from-primary/12 to-transparent"
          />

          <DialogHeader className="relative items-center gap-3 text-center sm:text-center">
            <img
              src="/logo.svg"
              alt=""
              className="size-10 object-contain"
              decoding="async"
            />
            <div className="space-y-1.5">
              <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                {t("export.progressTitle")}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {status ?? t("export.rendering")}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="relative mt-7 space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                {t("export.exporting")}
              </span>
              <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                {pct}
                <span className="ml-0.5 text-sm font-medium text-muted-foreground">
                  %
                </span>
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="relative mt-7 h-11 w-full rounded-xl"
            onClick={() => cancelActiveExport()}
          >
            {t("export.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
