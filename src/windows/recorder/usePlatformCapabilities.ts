/**
 * Platform capabilities, fetched once from Rust and cached for the process
 * lifetime (they cannot change while the app runs). Until the fetch resolves,
 * `null` — callers should render the optimistic (macOS-parity) UI and only
 * *remove* affordances once flags arrive, so nothing flashes in.
 */

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
