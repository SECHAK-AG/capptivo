//! Capptivo's native render engine.
//!
//! The editor's preview and export both render through this crate, so what
//! the user scrubs is, by construction, what the exported file contains:
//!
//! ```text
//! decode (ffmpeg, NV12) ─▶ scene (pure: document × time) ─▶ GPU compositor (wgpu)
//!                                                                │ NV12
//!                                                                ▼
//!                                                   encode (ffmpeg, hardware H.264)
//! ```
//!
//! * [`document`] — the JSON contract with the editor.
//! * [`timeline`] / [`layout`] — the editor's motion and layout math, ported
//!   one-to-one and pinned by golden vectors produced by the TypeScript code.

pub mod assets;
pub mod color;
pub mod document;
pub mod encode;
pub mod error;
pub mod export;
pub mod gpu;
pub mod layout;
pub mod math;
pub mod media;
pub mod project;
pub mod scene;
pub mod timeline;

pub use error::{EngineError, Result};
