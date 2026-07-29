import { cn } from "@/lib/utils";

/** Stroke-size control — `public/brush.svg` tinted via `currentColor`. */
export function BrushSizeIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none inline-block shrink-0 bg-current", className)}
      style={{
        mask: "url(/brush.svg) center / contain no-repeat",
        WebkitMask: "url(/brush.svg) center / contain no-repeat",
      }}
    />
  );
}
