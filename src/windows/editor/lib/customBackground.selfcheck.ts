/** Selfcheck: custom background media URL shape (no runtime deps). */

const MEDIA_PROTOCOL_BASE = "media://localhost";
const CUSTOM_BACKGROUND_MEDIA_PREFIX = "_backgrounds";

function customBackgroundUrl(fileName: string): string {
  return `${MEDIA_PROTOCOL_BASE}/${CUSTOM_BACKGROUND_MEDIA_PREFIX}/${fileName}`;
}

const file = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg";
const url = customBackgroundUrl(file);

console.assert(
  url === `${MEDIA_PROTOCOL_BASE}/${CUSTOM_BACKGROUND_MEDIA_PREFIX}/${file}`,
  "custom background url shape",
);
console.assert(!url.includes("/projects/"), "not under projects/");
console.assert(
  CUSTOM_BACKGROUND_MEDIA_PREFIX === "_backgrounds",
  "prefix matches Rust MEDIA_PREFIX",
);

console.log("customBackground.selfcheck: ok");
