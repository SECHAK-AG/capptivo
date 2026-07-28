/** Platform capabilities from Rust — cached for the process lifetime. */

import { useEffect, useState } from "react";

import { commands } from "../../ipc/bindings";
import type { PlatformCapabilities } from "../../ipc/types";

let cached: PlatformCapabilities | null = null;
let inflight: Promise<PlatformCapabilities> | null = null;

function fetchCapabilities(): Promise<PlatformCapabilities> {
  inflight ??= commands.platformCapabilities().then((caps) => {
    cached = caps;
    return caps;
  });
  return inflight;
}

export function usePlatformCapabilities(): PlatformCapabilities | null {
  const [caps, setCaps] = useState<PlatformCapabilities | null>(cached);

  useEffect(() => {
    if (caps) return;
    let cancelled = false;
    void fetchCapabilities().then((next) => {
      if (!cancelled) setCaps(next);
    });
    return () => {
      cancelled = true;
    };
  }, [caps]);

  return caps;
}
