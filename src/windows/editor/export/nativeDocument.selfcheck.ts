/**
 * Runnable check for the native export's camera-file mapping. Run:
 *   node --experimental-strip-types src/windows/editor/export/nativeDocument.selfcheck.ts
 *
 * The failure this guards: a media URL that is not a plain file directly in
 * the project folder (another project, a sub-path, a traversal) being handed
 * to the native engine as the face-cam. Rust re-validates the name too; this
 * keeps the editor from ever asking.
 */

import { projectFileName } from "./nativeDocument.ts";

export {}; // module scope

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const BASE = "media://localhost";
const ID = "2026-08-24-958d1f";

assert(
  projectFileName(`${BASE}/${ID}/camera.mp4`, ID, BASE) === "camera.mp4",
  "a project file maps to its name",
);
assert(
  projectFileName(`${BASE}/${ID}/camera%20take.webm?t=1`, ID, BASE) === "camera take.webm",
  "escapes decode and query strings drop",
);
assert(projectFileName(null, ID, BASE) === null, "no camera means no file");
assert(
  projectFileName(`${BASE}/other-project/camera.mp4`, ID, BASE) === null,
  "another project's file is refused",
);
assert(
  projectFileName(`${BASE}/${ID}/sub/camera.mp4`, ID, BASE) === null,
  "sub-paths are refused",
);
assert(
  projectFileName(`${BASE}/${ID}/..%2Fcamera.mp4`, ID, BASE) === null,
  "encoded traversal is refused",
);
assert(
  projectFileName(`http://media.localhost/${ID}/camera.mp4`, ID, "http://media.localhost") ===
    "camera.mp4",
  "the Windows media origin works the same way",
);

console.log("nativeDocument.selfcheck: ok");
