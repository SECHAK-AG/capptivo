//! Local project storage — the desktop replacement for the server DB + object
//! store. See TAURI_DESKTOP_MIGRATION.md §9.

pub mod model;
pub mod proxy;
pub mod store;
pub mod thumbnail;

pub use model::{Project, ProjectSummary};
pub use store::ProjectStore;
