/**
 * Hook: `media://` → same-origin `blob:` for GPU-safe `<video>` playback.
 * Revokes the previous blob when the source URL changes or on unmount.
 * Aborts in-flight ranged reads so a proxy swap does not finish pulling the
 * full screen file into memory.
 */

import { useEffect, useState } from "react";
import { isSameOriginMediaUrl, toBlobMediaUrl } from "./mediaBlobUrl";

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

export function useSameOriginMediaUrl(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    url && isSameOriginMediaUrl(url) ? url : null,
  );

  useEffect(() => {
    if (!url) {
      setSrc(null);
      return;
    }
    if (isSameOriginMediaUrl(url)) {
      setSrc(url);
      return;
    }

    const ac = new AbortController();
    let revoke: () => void = () => undefined;

    setSrc(null);
    void toBlobMediaUrl(url, { signal: ac.signal })
      .then((media) => {
        if (ac.signal.aborted) {
          media.revoke();
          return;
        }
        revoke = media.revoke;
        setSrc(media.src);
      })
      .catch((e) => {
        if (isAbortError(e) || ac.signal.aborted) return;
        console.error(
          "[preview] failed to materialize same-origin media",
          url,
          e,
        );
        setSrc(null);
      });

    return () => {
      ac.abort();
      revoke();
    };
  }, [url]);

  return src;
}
