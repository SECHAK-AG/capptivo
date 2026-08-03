/** Click-through crop outline — window geometry is the rect (no fullscreen dim). */

export function AreaFrameApp() {
  return (
    <div
      className="pointer-events-none box-border h-screen w-screen rounded-sm border-2 border-dashed border-sky-400 bg-transparent"
      aria-hidden
    />
  );
}
