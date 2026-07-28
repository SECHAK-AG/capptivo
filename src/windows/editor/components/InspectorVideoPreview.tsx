/**
 * Video thumb for inspector panels (screen crop, zoom reference). Tauri's
 * `media://` protocol needs CORS + a seek to decode the first painted frame —
 * bare `<video preload="metadata">` often stays blank in WKWebView.
 */

import { useEffect, useRef } from "react";

export function InspectorVideoPreview({
  src,
  seekTo,
  className,
  style,
  onAspect,
}: {
  src: string;
  /** Source time to show (seconds). Omit to keep the current frame. */
  seekTo?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Reports width ÷ height once metadata loads — for callers that don't know it. */
  onAspect?: (aspect: number) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  // Ref'd so the metadata effect doesn't re-run on every parent render.
  const onAspectRef = useRef(onAspect);
  onAspectRef.current = onAspect;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    const report = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        onAspectRef.current?.(v.videoWidth / v.videoHeight);
      }
    };

    if (v.readyState >= 1) {
      report();
      return;
    }
    v.addEventListener("loadedmetadata", report, { once: true });
    return () => v.removeEventListener("loadedmetadata", report);
  }, [src]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    const paint = () => {
      const t = seekTo ?? 0;
      // Nudge off exact 0 — some decoders skip painting the first keyframe at t=0.
      const target = t > 0.05 ? t : 0.001;
      if (Math.abs(v.currentTime - target) > 0.04) {
        v.currentTime = target;
      }
    };

    // Always paint once when the source loads; later seekTo updates scrub the frame.
    if (v.readyState >= 1) {
      if (seekTo !== undefined || v.currentTime < 0.0005) paint();
    } else {
      v.addEventListener("loadedmetadata", paint, { once: true });
    }

    return () => v.removeEventListener("loadedmetadata", paint);
  }, [src, seekTo]);

  return (
    <video
      ref={ref}
      key={src}
      src={src}
      className={className}
      style={style}
      muted
      playsInline
      preload="auto"
      crossOrigin="anonymous"
    />
  );
}
