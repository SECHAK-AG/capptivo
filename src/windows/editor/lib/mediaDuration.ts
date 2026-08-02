/**
 * A usable duration for a media element.
 *
 * `MediaRecorder` writes a *live* container: no Duration element and no seek
 * index, so `<video>.duration` is `Infinity` until the engine reaches the end —
 * and on some engines forever. Every timing guard in the editor is written as
 * `Number.isFinite(duration) && duration > 0`, so an `Infinity` silently
 * disables face-cam sync, seeking and paused-frame priming rather than failing
 * loudly. `seekable` is populated from the bytes the engine has actually
 * buffered, which for a fully-loaded `blob:` source is the whole file.
 *
 * The recorded face-cam is normalized to a seekable MP4 before the editor plays
 * it (`project/camera_track.rs`), so this is the backstop for the window before
 * that lands and for any duration-less source added later — not the fix.
 */
export function mediaDuration(media: {
  duration: number;
  seekable: { length: number; end: (index: number) => number };
}): number {
  const declared = media.duration;
  if (Number.isFinite(declared) && declared > 0) return declared;

  const { seekable } = media;
  if (seekable.length > 0) {
    const buffered = seekable.end(seekable.length - 1);
    if (Number.isFinite(buffered) && buffered > 0) return buffered;
  }
  return 0;
}
