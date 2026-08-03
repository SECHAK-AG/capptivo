//! IPC command surface. Kept deliberately small (§7); every command is a thin
//! adapter over a domain module. Registered in one place via
//! [`generate_handler!`](crate::commands::handlers).

pub mod backgrounds;
pub mod captions;
pub mod export;
pub mod project;
pub mod recording;

/// The full invoke handler. Referenced from `lib.rs`. Adding a command means
/// adding it here, to `COMMANDS` in `build.rs`, and to the matching capability
/// under `capabilities/` (ACL is deny-by-default once `AppManifest::commands` is set).
#[macro_export]
macro_rules! command_handlers {
    () => {
        tauri::generate_handler![
            // recording
            $crate::commands::recording::list_capture_sources,
            $crate::commands::recording::list_capture_devices,
            $crate::commands::recording::list_microphones,
            $crate::commands::recording::warm_microphone,
            $crate::commands::recording::cool_microphone,
            $crate::commands::recording::platform_capabilities,
            $crate::commands::recording::check_permissions,
            $crate::commands::recording::request_screen_permission,
            $crate::commands::recording::open_screen_recording_settings,
            $crate::commands::recording::relaunch,
            $crate::commands::recording::recorder_state,
            $crate::commands::recording::prepare_window_capture,
            $crate::commands::recording::start_recording,
            $crate::commands::recording::pause_recording,
            $crate::commands::recording::resume_recording,
            $crate::commands::recording::set_recording_mic_muted,
            $crate::commands::recording::stop_recording,
            $crate::commands::recording::pick_capture_area,
            $crate::commands::recording::complete_area_pick,
            $crate::commands::recording::cancel_area_pick,
            $crate::commands::recording::show_area_frame_guide,
            $crate::commands::recording::hide_area_frame_guide,
            $crate::commands::recording::mark_camera_started,
            $crate::commands::recording::begin_camera_file,
            $crate::commands::recording::write_camera_chunk,
            $crate::commands::recording::finish_camera_file,
            $crate::windows::hide_recorder,
            $crate::windows::set_recorder_layout,
            $crate::windows::set_recorder_bar_width,
            $crate::windows::set_recorder_bar_hitbox,
            $crate::windows::recorder_menu_space,
            $crate::windows::set_recorder_menu,
            $crate::windows::set_recorder_menu_live,
            $crate::windows::begin_recorder_drag,
            $crate::windows::end_recorder_drag,
            $crate::windows::show_camera_preview,
            $crate::windows::hide_camera_preview,
            $crate::windows::dismiss_camera_preview,
            $crate::windows::set_camera_preview_visible,
            $crate::windows::arm_camera_capture,
            $crate::windows::flush_camera_capture,
            $crate::windows::show_annotation_overlay,
            $crate::windows::hide_annotation_overlay,
            $crate::windows::set_annotation_display_follow,
            $crate::windows::open_library,
            $crate::windows::open_editor,
            $crate::windows::present_window,
            $crate::commands::captions::get_whisper_model_status,
            $crate::commands::captions::download_whisper_model,
            $crate::commands::captions::delete_whisper_model,
            $crate::commands::captions::generate_captions,
            // projects
            $crate::commands::project::list_projects,
            $crate::commands::project::load_project,
            $crate::commands::project::ensure_proxy,
            $crate::commands::project::ensure_camera_track,
            $crate::commands::project::save_editor_state,
            $crate::commands::project::rename_project,
            $crate::commands::project::delete_project,
            $crate::commands::project::ensure_thumbnail,
            // custom backgrounds (global library under app data)
            $crate::commands::backgrounds::save_custom_background,
            $crate::commands::backgrounds::list_custom_backgrounds,
            $crate::commands::backgrounds::delete_custom_background,
            // export
            $crate::commands::export::ensure_seekable_recording,
            $crate::commands::export::check_export_disk_space,
            $crate::commands::export::begin_export,
            $crate::commands::export::write_export_chunk,
            $crate::commands::export::finish_export,
            $crate::commands::export::abort_export,
            $crate::commands::export::mux_export_audio,
            $crate::commands::export::prepare_export_audio,
            $crate::commands::export::attach_export_audio,
            $crate::commands::export::remove_temp_file,
            // updater
            $crate::updater::check_for_updates,
        ]
    };
}
