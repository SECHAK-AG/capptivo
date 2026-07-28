/** Dimmed surround + border for an area capture region (picker + on-screen guide). */

export type AreaRect = { x: number; y: number; width: number; height: number };

const DIM = "rgba(0, 0, 0, 0.45)";

export function AreaRegionChrome({ rect }: { rect: AreaRect }) {
  const { x, y, width, height } = rect;
  const panelStyle = { backgroundColor: DIM };

  return (
    <>
      <div
        className="pointer-events-none absolute"
        style={{ left: 0, top: 0, right: 0, height: y, ...panelStyle }}
      />
      <div
        className="pointer-events-none absolute"
        style={{ left: 0, top: y + height, right: 0, bottom: 0, ...panelStyle }}
      />
      <div
        className="pointer-events-none absolute"
        style={{ left: 0, top: y, width: x, height, ...panelStyle }}
      />
      <div
        className="pointer-events-none absolute"
        style={{ left: x + width, top: y, right: 0, height, ...panelStyle }}
      />
      <div
        className="pointer-events-none absolute rounded-sm border-2 border-sky-400 shadow-[0_0_0_1px_rgba(56,189,248,0.45)]"
        style={{ left: x, top: y, width, height }}
      />
    </>
  );
}
