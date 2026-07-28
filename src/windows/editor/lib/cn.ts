import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class-name combiner, matching the web editor's `cn` helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
