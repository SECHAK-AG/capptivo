/** Click-through crop outline — window geometry is the rect (no fullscreen dim). */

/**
 * WebView2 drops fully-transparent layers (border-only paints vanish). Keep a
 * tiny sky fill + matching shadow so the dashed edge composites on Windows;
 * macOS is fine either way.
 */
export function AreaFrameApp() {
  return (
    <div
      className="pointer-events-none box-border h-screen w-screen rounded-sm border-2 border-dashed border-sky-400 shadow-[0_0_0_1px_rgba(56,189,248,0.45)]"
      style={{ backgroundColor: "rgba(56, 189, 248, 0.07)" }}
      aria-hidden
    />
  );
}
