/** Minimal shadcn-flavored primitives, styled with the ported design tokens. */

import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export function Slider({
  id,
  min,
  max,
  step = 1,
  value,
  onChange,
  className,
}: {
  id?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary",
        className,
      )}
    />
  );
}

export function FieldLabel({
  htmlFor,
  hint,
  children,
}: {
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      title={hint}
      className="flex items-center gap-1 text-sm font-medium text-foreground"
    >
      {children}
      {hint && (
        <span
          className="grid h-3.5 w-3.5 place-items-center rounded-full border border-muted-foreground/40 text-[9px] text-muted-foreground"
          aria-hidden
        >
          ?
        </span>
      )}
    </label>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary"
          ? "bg-primary text-primary-foreground hover:opacity-90"
          : "border border-border text-foreground hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}
