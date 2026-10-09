//! Time-only math: everything about *when* and *where*, nothing about pixels.
//!
//! Every function here is a pure function of the render document and a source
//! time, so the preview and the export sample identical values.

pub mod captions;
pub mod cursor;
pub mod face_cam;
pub mod segments;
pub mod zoom;
