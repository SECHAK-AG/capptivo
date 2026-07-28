import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

const sliderRangeVariants = {
  /** Filled range matches theme primary (CTAs, strong accent). */
  default: "bg-primary",
  /** Muted, neutral; use for most forms so on-canvas / overlay accents stay distinct. */
  subtle: "bg-foreground/25 dark:bg-foreground/35",
} as const;

const sliderThumbVariants = {
  default:
    "border border-primary bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden",
  subtle:
    "border-2 border-border bg-background shadow-sm ring-0 transition-[color,box-shadow] hover:ring-2 hover:ring-foreground/10 focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:outline-hidden",
} as const;

export type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  /**
   * `default` = brand primary fill and thumb.
   * `subtle` = neutral track fill (opt-in where a calmer control is needed).
   */
  variant?: keyof typeof sliderRangeVariants;
};

function Slider({
  className,
  variant: variantProp = "default",
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderProps) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max],
  );
  const variant = variantProp;

  return (
    <SliderPrimitive.Root
      data-variant={variant}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
            sliderRangeVariants[variant],
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className={cn(
            "block size-4 shrink-0 rounded-full transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50",
            sliderThumbVariants[variant],
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
