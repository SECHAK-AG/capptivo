/**
 * Interactive editor preview URL: prefer the downscaled proxy when ready,
 * otherwise the original. Export / `sourceVideoSize` always use `screenUrl`.
 */
export function screenPreviewUrl(
  proxyUrl: string | null,
  screenUrl: string | null,
): string | null {
  return proxyUrl ?? screenUrl;
}
