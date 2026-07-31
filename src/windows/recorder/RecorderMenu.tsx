/** Popover for the recorder bar — flips inside the work-area overlay. */

import { useEffect, type ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { setMenuLive, MENU_SIDE_OFFSET } from "./menuSurface";

const MENU_CONTENT =
  "rounded-xl border-border/80 bg-popover p-1.5 shadow-lg ring-1 ring-border/40 duration-150";

export function RecorderMenu({
  open,
  onOpenChange,
  align = "center",
  className,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: "start" | "center" | "end";
  className?: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    setMenuLive(true);
    return () => setMenuLive(false);
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align={align}
        sideOffset={MENU_SIDE_OFFSET}
        avoidCollisions
        collisionPadding={12}
        className={cn(MENU_CONTENT, className)}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
