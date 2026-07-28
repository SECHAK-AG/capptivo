import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/settings";

type Props = {
  exporting: boolean;
  disabled?: boolean;
  onExport: () => void;
};

/** Compact primary export control in the window title bar. */
export function ExportVideoButton({ exporting, disabled = false, onExport }: Props) {
  const { t } = useI18n();

  return (
    <Button
      type="button"
      size="sm"
      className="h-8 shrink-0 gap-2 px-6 has-[>svg]:px-6"
      onClick={onExport}
      disabled={exporting || disabled}
    >
      <Download className="size-4" aria-hidden />
      {exporting ? t("export.exporting") : t("titleBar.export")}
    </Button>
  );
}
