import { Info } from "lucide-react";
import * as React from "react";

import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";

export type FieldLabelWithHintProps = {
  htmlFor?: string;
  children: React.ReactNode;
  hint: React.ReactNode;
  /** Classes merged onto the `Label` (e.g. `text-xs`). */
  className?: string;
  triggerAriaLabel?: string;
};

export function FieldLabelWithHint({
  htmlFor,
  children,
  hint,
  className,
  triggerAriaLabel,
}: FieldLabelWithHintProps) {
  const { t } = useI18n();
  const ariaLabel = triggerAriaLabel ?? t("hint.more");
  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <Label htmlFor={htmlFor} className={cn("min-w-0 flex-1 text-muted-foreground", className)}>
        {children}
      </Label>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={ariaLabel}
          className="text-muted-foreground hover:text-foreground -mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3.5" strokeWidth={2} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-left text-xs font-normal leading-snug">
          {hint}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export type SectionHintProps = {
  hint: React.ReactNode;
  triggerAriaLabel?: string;
};

/** Standalone info icon + tooltip for section titles (no field label). */
export function SectionHint({ hint, triggerAriaLabel }: SectionHintProps) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={triggerAriaLabel ?? t("hint.moreShort")}
        className="text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="size-3.5" strokeWidth={2} aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs text-left text-xs font-normal leading-snug">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
