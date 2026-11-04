//! Export regressions: editor-only fields must survive the native JSON contract.
use capptivo_engine::document::{
    BlurRegion, CaptionCue, CaptionPosition, CaptionSettings, RecordingMetadata, ZoomFragment,
};
use capptivo_engine::timeline::captions::{caption_block_origin, CaptionTrack};
use capptivo_engine::timeline::zoom::compute_zoom_keyframes;
use serde_json::json;

#[test]
fn deleted_caption_does_not_make_remaining_caption_start_early() {
    let cue: CaptionCue = serde_json::from_value(json!({
        "id":"remaining", "startMs":3300, "endMs":6000,
        "text":"Jeg bad AI'en", "manual":true
    }))
    .unwrap();
    let track = CaptionTrack::new(&[cue]);
    for time in [0.0, 3299.0, 6000.0, 9000.0] {
        assert!(track.active(time).is_none(), "unexpected text at {time}");
    }
    assert_eq!(track.active(3300.0).unwrap().cue.text, "Jeg bad AI'en");
    assert!(track.active(5999.0).is_some());
}

#[test]
fn manual_caption_gaps_remain_empty() {
    let cues: Vec<CaptionCue> = serde_json::from_value(json!([
        {"startMs":1000,"endMs":2000,"text":"a","manual":true},
        {"startMs":4000,"endMs":5000,"text":"b","manual":true}
    ]))
    .unwrap();
    let track = CaptionTrack::new(&cues);
    assert!(track.active(3000.0).is_none());
    assert_eq!(track.active(4500.0).unwrap().cue.text, "b");
}

#[test]
fn native_caption_placement_uses_preset_and_per_caption_anchor() {
    let settings: CaptionSettings =
        serde_json::from_value(json!({"position":"top","bottomOffsetPx":180})).unwrap();
    let cue: CaptionCue =
        serde_json::from_value(json!({"startMs":0,"endMs":1000,"anchor":{"x":0.25,"y":0.2}}))
            .unwrap();
    let origin = |position, anchor| {
        caption_block_origin(
            (1080.0, 1920.0),
            (600.0, 100.0),
            position,
            settings.bottom_offset_px,
            anchor,
        )
    };
    assert_eq!(origin(settings.position, None), (240.0, 180.0));
    assert_eq!(origin(CaptionPosition::Center, None), (240.0, 910.0));
    assert_eq!(origin(CaptionPosition::Bottom, None), (240.0, 1640.0));
    assert_eq!(origin(settings.position, cue.anchor), (0.0, 334.0));
    assert_eq!(
        caption_block_origin(
            (100.0, 100.0),
            (200.0, 200.0),
            settings.position,
            180.0,
            None
        ),
        (0.0, 0.0)
    );
}

#[test]
fn native_blur_honors_visibility_and_source_time() {
    let mut region: BlurRegion =
        serde_json::from_value(json!({"x":0,"y":0,"width":0.2,"height":0.2,"start":3.3,"end":6}))
            .unwrap();
    assert!(!region.active_at(0.0));
    assert!(region.active_at(3.3));
    assert!(!region.active_at(6.0));
    region.enabled = Some(false);
    assert!(!region.active_at(4.0));
    let legacy: BlurRegion =
        serde_json::from_value(json!({"x":0,"y":0,"width":0.2,"height":0.2})).unwrap();
    assert!(legacy.active_at(100.0));
}

#[test]
fn typing_zoom_uses_field_target_without_mutating_cursor_track() {
    let fragment: ZoomFragment = serde_json::from_value(json!({"start":1,"end":3,"mode":"follow-cursor","targetScale":2,"followSource":"typing","typingFocus":{"x":0.75,"y":0.3}})).unwrap();
    let metadata: RecordingMetadata = serde_json::from_value(json!({"sourceWidth":1920,"sourceHeight":1080,"cursorSamples":[{"t":1,"x":0.1,"y":0.8},{"t":3,"x":0.1,"y":0.8}]})).unwrap();
    let original = metadata.clone();
    let actual = compute_zoom_keyframes(&fragment, Some(&metadata), 120.0, None, None);
    let mut expected_metadata = metadata.clone();
    for point in &mut expected_metadata.cursor_samples {
        point.x = 0.75;
        point.y = 0.3;
    }
    let mut plain = fragment.clone();
    plain.follow_source = None;
    plain.typing_focus = None;
    let expected = compute_zoom_keyframes(&plain, Some(&expected_metadata), 120.0, None, None);
    assert_eq!(actual, expected);
    assert_eq!(metadata, original);
    assert!(actual.last().unwrap().x > 0.6);
}

#[test]
fn recording_size_preserves_centre_and_aspect_for_export() {
    use capptivo_engine::{layout::scale_recording_rect, math::Rect};
    let base = Rect::new(120.0, 723.75, 840.0, 472.5);
    let enlarged = scale_recording_rect(base, 1.5);
    assert_eq!(enlarged.width, 1260.0);
    assert_eq!(enlarged.height, 708.75);
    assert_eq!(enlarged.x + enlarged.width / 2.0, 540.0);
    assert_eq!(enlarged.y + enlarged.height / 2.0, 960.0);
    assert_eq!(enlarged.width / enlarged.height, base.width / base.height);
    assert_eq!(scale_recording_rect(base, 1.0), base);
    assert_eq!(scale_recording_rect(base, f64::NAN), base);
    assert_eq!(scale_recording_rect(base, 99.0), scale_recording_rect(base, 3.0));
}

#[test]
fn recording_size_survives_saved_look_and_defaults_for_old_projects() {
    use capptivo_engine::document::Look;
    let legacy: Look = serde_json::from_value(json!({"devicePadding":120})).unwrap();
    assert_eq!(legacy.recording_scale, 1.0);
    let enlarged: Look = serde_json::from_value(json!({"recordingScale":1.5})).unwrap();
    assert_eq!(enlarged.recording_scale, 1.5);
    assert_eq!(serde_json::to_value(enlarged).unwrap()["recordingScale"], 1.5);
}
