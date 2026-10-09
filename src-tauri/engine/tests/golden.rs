//! The engine's math must reproduce the editor's TypeScript, number for number.
//!
//! `tests/golden/*.json` are written by `tests/golden/generate.mjs`, which runs
//! the editor's own modules on seeded synthetic inputs. If a test here fails,
//! either the port drifted or the TS changed — regenerate the vectors and port
//! the change; never loosen a tolerance to make it pass.

use std::path::PathBuf;

use capptivo_engine::document::{
    AspectRatioPreset, BlurRegion, CaptionCue, CropNorm, FaceCamCorner, Point, RecordingMetadata,
    Size, TrimSegment, ZoomFragment,
};
use capptivo_engine::layout::{self, FaceCamLayoutOptions, RecordingLayoutInput};
use capptivo_engine::math::Rect;
use capptivo_engine::timeline::captions::CaptionTrack;
use capptivo_engine::timeline::cursor::{
    cursor_bounce_scale, cursor_click_fx_progress, cursor_loop_return, cursor_spring_config,
    near_cursor_click, step_spring_value, CursorMotionState, MotionOptions, SpringState,
};
use capptivo_engine::timeline::face_cam::{face_cam_frame_at, FaceCamFrame};
use capptivo_engine::timeline::zoom::{
    camera_transform, compute_zoom_keyframes, interpolate_zoom_keyframe, zoom_envelope,
    zoom_reactive_state, Vec2, ZOOM_MOTION_SAMPLE_FPS,
};
use serde_json::Value;

/// libm differences between V8 and the platform allow last-ulp drift only.
const TOLERANCE: f64 = 1e-9;

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/golden/{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// A golden number; the generator spells non-finite values as strings.
fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        Value::String(s) if s == "NaN" => f64::NAN,
        other => panic!("not a number: {other}"),
    }
}

fn opt_num(v: &Value) -> Option<f64> {
    (!v.is_null()).then(|| num(v))
}

#[track_caller]
fn close(actual: f64, expected: f64, what: &str) {
    if actual == expected || (actual.is_nan() && expected.is_nan()) {
        return;
    }
    let scale = expected.abs().max(1.0);
    assert!(
        (actual - expected).abs() <= TOLERANCE * scale,
        "{what}: rust {actual} vs ts {expected} (Δ {})",
        actual - expected
    );
}

fn rect(v: &Value) -> Rect {
    Rect::new(
        num(&v["x"]),
        num(&v["y"]),
        num(&v["width"]),
        num(&v["height"]),
    )
}

fn crop(v: &Value) -> Option<CropNorm> {
    (!v.is_null()).then(|| serde_json::from_value(v.clone()).unwrap())
}

#[track_caller]
fn close_rect(actual: Rect, expected: &Value, what: &str) {
    close(actual.x, num(&expected["x"]), &format!("{what}.x"));
    close(actual.y, num(&expected["y"]), &format!("{what}.y"));
    close(
        actual.width,
        num(&expected["width"]),
        &format!("{what}.width"),
    );
    close(
        actual.height,
        num(&expected["height"]),
        &format!("{what}.height"),
    );
}

fn metadata() -> RecordingMetadata {
    serde_json::from_value(load("metadata")).unwrap()
}

#[test]
fn layout_matches_editor() {
    for (i, case) in load("layout").as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let preset: AspectRatioPreset = serde_json::from_value(input["presetId"].clone()).unwrap();
        let size: Size = serde_json::from_value(input["sourceVideoSize"].clone()).unwrap();
        let what = format!("layout[{i}]");

        let stage = layout::resolve_stage_size(preset, Some(size));
        close(
            stage.width,
            num(&case["stage"]["width"]),
            &format!("{what}.stage.width"),
        );
        close(
            stage.height,
            num(&case["stage"]["height"]),
            &format!("{what}.stage.height"),
        );
        let export = layout::export_dimensions_for_video(stage.width, stage.height, 1920.0);
        close(export.width, num(&case["exportDims"]["width"]), &what);
        close(export.height, num(&case["exportDims"]["height"]), &what);
        let gif = layout::export_dimensions_for_video(stage.width, stage.height, 1280.0);
        close(gif.width, num(&case["gifDims"]["width"]), &what);
        close(gif.height, num(&case["gifDims"]["height"]), &what);

        let recording = RecordingLayoutInput {
            preset,
            source_aspect: num(&input["sourceAspect"]),
            source_video_size: Some(size),
            has_selected_background: input["hasSelectedBackground"].as_bool().unwrap(),
            has_image_background: input["hasImageBackground"].as_bool().unwrap(),
            device_padding: num(&input["devicePadding"]),
            screen_content_crop: crop(&input["crop"]),
        };
        let (aspect, padding) = layout::recording_layout_params(&recording);
        close(
            aspect,
            num(&case["params"]["sourceAspect"]),
            &format!("{what}.aspect"),
        );
        close(
            padding,
            num(&case["params"]["devicePadding"]),
            &format!("{what}.padding"),
        );
        let (device, video) =
            layout::composition_layout(aspect, stage.width, stage.height, padding);
        close_rect(device, &case["layout"]["device"], &format!("{what}.device"));
        close_rect(video, &case["layout"]["video"], &format!("{what}.video"));
        let fraction = layout::recording_rect_fraction(&recording, stage.width, stage.height);
        close_rect(
            fraction,
            &case["zoomLayout"]["video"],
            &format!("{what}.zoomLayout"),
        );
    }
}

#[test]
fn zoom_keyframes_match_editor() {
    let metadata = metadata();
    for case in load("zoom").as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let fragment: ZoomFragment = serde_json::from_value(case["fragment"].clone()).unwrap();
        let keyframes = compute_zoom_keyframes(
            &fragment,
            Some(&metadata),
            ZOOM_MOTION_SAMPLE_FPS,
            crop(&case["crop"]),
            Some(rect(&case["layout"]["video"])),
        );
        let expected = case["keyframes"].as_array().unwrap();
        assert_eq!(keyframes.len(), expected.len(), "{name}: keyframe count");
        for (k, (actual, e)) in keyframes.iter().zip(expected).enumerate() {
            close(actual.t, num(&e["t"]), &format!("{name}.kf[{k}].t"));
            close(actual.x, num(&e["x"]), &format!("{name}.kf[{k}].x"));
            close(actual.y, num(&e["y"]), &format!("{name}.kf[{k}].y"));
            close(
                actual.scale,
                num(&e["scale"]),
                &format!("{name}.kf[{k}].scale"),
            );
        }
        for (s, sample) in case["samples"].as_array().unwrap().iter().enumerate() {
            let t = num(&sample["t"]);
            let k = interpolate_zoom_keyframe(&keyframes, t);
            close(k.x, num(&sample["x"]), &format!("{name}.sample[{s}].x"));
            close(k.y, num(&sample["y"]), &format!("{name}.sample[{s}].y"));
            close(
                k.scale,
                num(&sample["scale"]),
                &format!("{name}.sample[{s}].scale"),
            );
            close(zoom_envelope(&fragment, t), num(&sample["envelope"]), name);
            let active = (t >= fragment.start && t <= fragment.end).then_some(&fragment);
            let reactive = zoom_reactive_state(active, t);
            close(
                reactive.face_cam_presence_scale,
                num(&sample["reactive"]["faceCamPresenceScale"]),
                &format!("{name}.sample[{s}].presence"),
            );
            match sample["reactive"].get("zoomTargetScale") {
                Some(v) => close(reactive.target_scale.unwrap(), num(v), name),
                None => assert_eq!(
                    reactive.target_scale, None,
                    "{name}.sample[{s}].targetScale"
                ),
            }
        }
    }
}

#[test]
fn camera_transform_matches_editor() {
    for (i, case) in load("camera").as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let out = camera_transform(
            num(&input["stageWidth"]),
            num(&input["stageHeight"]),
            rect(&input["videoRect"]),
            Vec2::new(num(&input["focus"]["x"]), num(&input["focus"]["y"])),
            num(&input["scale"]),
            input.get("targetScale").map(num),
        );
        close(
            out.scale,
            num(&case["output"]["scale"]),
            &format!("camera[{i}].scale"),
        );
        close(out.x, num(&case["output"]["x"]), &format!("camera[{i}].x"));
        close(out.y, num(&case["output"]["y"]), &format!("camera[{i}].y"));
    }
}

#[test]
fn face_cam_layout_matches_editor() {
    for (i, case) in load("facecam").as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let o = &input["options"];
        let opt = |key: &str| o.get(key).and_then(opt_num);
        let options = FaceCamLayoutOptions {
            shadow_intensity: num(&o["shadowIntensity"]),
            corner_roundness: opt("cornerRoundness"),
            width_px: opt("widthPx"),
            height_px: opt("heightPx"),
            force_circle: o["forceCircle"].as_bool().unwrap(),
            position_override: o
                .get("positionOverride")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value::<Point>(v.clone()).unwrap()),
            corner: serde_json::from_value::<FaceCamCorner>(o["corner"].clone()).unwrap(),
            crop: o.get("crop").and_then(crop),
            presence_scale: opt("presenceScale"),
            margin_px: opt("marginPx"),
        };
        let what = format!("facecam[{i}]");
        let layout = layout::face_cam_layout(
            num(&input["videoWidth"]),
            num(&input["videoHeight"]),
            num(&input["width"]),
            num(&input["height"]),
            &options,
        )
        .unwrap();
        let e = &case["layout"];
        close(layout.x, num(&e["x"]), &format!("{what}.x"));
        close(layout.y, num(&e["y"]), &format!("{what}.y"));
        close(
            layout.cam_width,
            num(&e["camWidth"]),
            &format!("{what}.camWidth"),
        );
        close(
            layout.cam_height,
            num(&e["camHeight"]),
            &format!("{what}.camHeight"),
        );
        close(
            layout.corner_radius,
            num(&e["cornerRadius"]),
            &format!("{what}.radius"),
        );
        close(
            layout.presence_scale,
            num(&e["presenceScale"]),
            &format!("{what}.presence"),
        );
        close(
            layout.source.x,
            num(&e["sourceX"]),
            &format!("{what}.sourceX"),
        );
        close(
            layout.source.y,
            num(&e["sourceY"]),
            &format!("{what}.sourceY"),
        );
        close(
            layout.source.width,
            num(&e["sourceWidth"]),
            &format!("{what}.sourceWidth"),
        );
        close(
            layout.source.height,
            num(&e["sourceHeight"]),
            &format!("{what}.sourceHeight"),
        );
        let s = &e["shadow"];
        let sh = layout.shadow;
        for (actual, key) in [
            (sh.x, "x"),
            (sh.y, "y"),
            (sh.w, "w"),
            (sh.h, "h"),
            (sh.r, "r"),
            (sh.soft_sigma, "softSigma"),
            (sh.soft_opacity, "softOpacity"),
            (sh.tight_sigma, "tightSigma"),
            (sh.tight_opacity, "tightOpacity"),
            (sh.offset_x, "offsetX"),
            (sh.offset_y, "offsetY"),
        ] {
            close(actual, num(&s[key]), &format!("{what}.shadow.{key}"));
        }
        for (p, (actual, expected)) in layout::face_cam_shadow_passes(&sh)
            .iter()
            .zip(case["passes"].as_array().unwrap())
            .enumerate()
        {
            close(
                actual.sigma,
                num(&expected["sigma"]),
                &format!("{what}.pass[{p}].sigma"),
            );
            close(
                actual.opacity,
                num(&expected["opacity"]),
                &format!("{what}.pass[{p}].opacity"),
            );
            close(
                actual.offset_x,
                num(&expected["offsetX"]),
                &format!("{what}.pass[{p}].ox"),
            );
            close(
                actual.offset_y,
                num(&expected["offsetY"]),
                &format!("{what}.pass[{p}].oy"),
            );
        }
    }
}

#[test]
fn shadows_presence_and_blur_regions_match_editor() {
    for case in load("shadow").as_array().unwrap() {
        let passes =
            layout::recording_shadow_passes(num(&case["intensity"]), num(&case["shortEdge"]));
        let expected = case["passes"].as_array().unwrap();
        assert_eq!(passes.len(), expected.len());
        for (a, e) in passes.iter().zip(expected) {
            close(a.sigma, num(&e["sigma"]), "shadow.sigma");
            close(a.opacity, num(&e["opacity"]), "shadow.opacity");
        }
    }
    for case in load("presence").as_array().unwrap() {
        close(
            layout::face_cam_zoom_presence_scale(num(&case["env"]), num(&case["min"])),
            num(&case["out"]),
            "presence",
        );
    }
    for (i, case) in load("blur").as_array().unwrap().iter().enumerate() {
        let region: BlurRegion = serde_json::from_value(case["region"].clone()).unwrap();
        let c = &case["content"];
        let content = Rect::new(num(&c["ox"]), num(&c["oy"]), num(&c["rw"]), num(&c["rh"]));
        let placement =
            layout::blur_region_placement(&region, 3024.0, 1964.0, content, rect(&case["rect"]));
        match (placement, case["placement"].is_null()) {
            (None, true) => {}
            (Some((source, dest)), false) => {
                close_rect(
                    source,
                    &case["placement"]["source"],
                    &format!("blur[{i}].source"),
                );
                close_rect(dest, &case["placement"]["dest"], &format!("blur[{i}].dest"));
            }
            (actual, _) => panic!("blur[{i}]: rust {actual:?} vs ts {}", case["placement"]),
        }
    }
}

#[test]
fn face_cam_time_and_loop_return_match_editor() {
    for (i, case) in load("facecam_time").as_array().unwrap().iter().enumerate() {
        let frame = face_cam_frame_at(
            num(&case["t"]),
            opt_num(&case["offsetMs"]),
            num(&case["duration"]),
        );
        let e = &case["frame"];
        match (frame, e["state"].as_str().unwrap()) {
            (FaceCamFrame::Before, "before") => {}
            (FaceCamFrame::Active(t), "active") | (FaceCamFrame::Hold(t), "hold") => {
                close(t, num(&e["mediaTime"]), &format!("facecam_time[{i}]"));
            }
            (actual, expected) => panic!("facecam_time[{i}]: rust {actual:?} vs ts {expected}"),
        }
    }
    for case in load("loop_return").as_array().unwrap() {
        let segments: Vec<TrimSegment> = serde_json::from_value(case["segments"].clone()).unwrap();
        let out = cursor_loop_return(&segments, num(&case["duration"]));
        match (out, case["out"].is_null()) {
            (None, true) => {}
            (Some(l), false) => {
                close(
                    l.target_time,
                    num(&case["out"]["targetTime"]),
                    "loop.target",
                );
                close(
                    l.window_start,
                    num(&case["out"]["windowStart"]),
                    "loop.start",
                );
                close(l.window_end, num(&case["out"]["windowEnd"]), "loop.end");
            }
            (actual, _) => panic!("loop return: rust {actual:?} vs ts {}", case["out"]),
        }
    }
}

#[test]
fn caption_timing_matches_editor() {
    let golden = load("captions");
    let cues: Vec<CaptionCue> = serde_json::from_value(golden["cues"].clone()).unwrap();
    let track = CaptionTrack::new(&cues);
    for case in golden["cases"].as_array().unwrap() {
        let ms = num(&case["timeMs"]);
        let active = track.active(ms);
        match (active, case["cueId"].as_str()) {
            (None, None) => {}
            (Some(a), Some(id)) => {
                assert_eq!(a.cue.id, id, "cue at {ms} ms");
                assert_eq!(
                    a.active_word_index as i64,
                    case["activeWordIndex"].as_i64().unwrap(),
                    "word at {ms} ms"
                );
                let words: Vec<&str> = a.words.iter().map(|w| w.text.as_str()).collect();
                let expected: Vec<&str> = case["words"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|w| w.as_str().unwrap())
                    .collect();
                assert_eq!(words, expected, "words at {ms} ms");
            }
            (a, e) => panic!(
                "captions at {ms} ms: rust {:?} vs ts {e:?}",
                a.map(|a| a.cue.id.clone())
            ),
        }
    }
}

#[test]
fn cursor_spring_matches_editor() {
    for case in load("spring").as_array().unwrap() {
        let config = cursor_spring_config(num(&case["smoothness"]));
        let mut state = SpringState::new(0.0);
        for (i, step) in case["values"].as_array().unwrap().iter().enumerate() {
            let value =
                step_spring_value(&mut state, num(&step["target"]), num(&step["dt"]), &config);
            close(value, num(&step["value"]), &format!("spring[{i}].value"));
            close(
                state.velocity,
                num(&step["velocity"]),
                &format!("spring[{i}].velocity"),
            );
        }
    }
}

#[test]
fn cursor_motion_matches_editor() {
    let mut motion = CursorMotionState::default();
    for (i, step) in load("cursor_motion").as_array().unwrap().iter().enumerate() {
        let o = &step["opts"];
        let out = motion.update(
            Vec2::new(num(&step["target"]["x"]), num(&step["target"]["y"])),
            num(&step["t"]),
            MotionOptions {
                smoothness: num(&o["smoothness"]),
                sway: num(&o["sway"]),
                motion_blur: num(&o["motionBlur"]),
                freeze: o["freeze"].as_bool().unwrap(),
                near_click: o["nearClick"].as_bool().unwrap(),
            },
        );
        let e = &step["out"];
        close(out.position.x, num(&e["x"]), &format!("motion[{i}].x"));
        close(out.position.y, num(&e["y"]), &format!("motion[{i}].y"));
        close(
            out.rotation,
            num(&e["rotation"]),
            &format!("motion[{i}].rotation"),
        );
        let trail = e["trail"].as_array().unwrap();
        assert_eq!(out.trail.len(), trail.len(), "motion[{i}].trail length");
        for (a, b) in out.trail.iter().zip(trail) {
            close(a.x, num(&b["x"]), &format!("motion[{i}].trail.x"));
            close(a.y, num(&b["y"]), &format!("motion[{i}].trail.y"));
        }
    }
}

#[test]
fn cursor_clicks_match_editor() {
    let metadata = metadata();
    let press = &metadata.cursor_press_intervals;
    assert_eq!(
        press.last().unwrap().end,
        f64::INFINITY,
        "unclosed hold survives JSON"
    );
    for case in load("cursor_click").as_array().unwrap() {
        let t = num(&case["t"]);
        assert_eq!(
            near_cursor_click(press, t),
            case["near"].as_bool().unwrap(),
            "near click at {t}"
        );
        close(
            cursor_bounce_scale(press, t, 0.2),
            num(&case["bounce"]),
            "bounce",
        );
        close(cursor_click_fx_progress(press, t), num(&case["fx"]), "fx");
    }
}

/// The editor's own document builder (`nativeDocument.ts`), serialized the way
/// `invoke` does, must deserialize into exactly what the editor meant.
#[test]
fn editor_document_deserializes_faithfully() {
    use capptivo_engine::document::{
        BackgroundType, ClickEffect, CursorStyle, FaceCamCorner, Look, RenderDocument, ZoomMode,
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/document.json");
    let doc: RenderDocument = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();

    assert_eq!(doc.aspect_ratio_preset_id, AspectRatioPreset::Wide16x9);
    assert_eq!(doc.background_type, BackgroundType::Image);
    assert_eq!(doc.look, Look::default(), "DEFAULT_LOOK round-trips");
    assert_eq!(doc.cursor_settings.style, CursorStyle::Tahoe);
    assert_eq!(doc.cursor_settings.click_effect, ClickEffect::None);
    assert_eq!(doc.cursor_settings.size, 3.0);
    assert_eq!(doc.face_cam.corner, FaceCamCorner::BottomRight);
    assert_eq!(
        (doc.face_cam.width_px, doc.face_cam.height_px),
        (400.0, 300.0)
    );
    assert!(doc.face_cam.mirrored && doc.face_cam.position.is_none());
    assert_eq!(doc.camera_offset_ms, Some(-2.0));
    assert_eq!(doc.segments.len(), 2);
    assert_eq!(doc.blur_regions.len(), 1);
    assert_eq!(doc.screen_content_crop.unwrap().y, 0.03);

    // Every zoom fragment survives, including one with deprecated fields.
    assert_eq!(doc.zoom_fragments.len(), 6);
    let fixed = doc
        .zoom_fragments
        .iter()
        .filter(|f| f.mode == ZoomMode::FixedRect)
        .count();
    assert_eq!(fixed, 2);
    assert!(doc
        .zoom_fragments
        .iter()
        .filter(|f| f.mode == ZoomMode::FixedRect)
        .all(|f| f.fixed_rect.is_some()));

    // `Infinity` crossed IPC as `null` and came back as an unclosed hold.
    let meta = doc.recording_metadata.as_ref().unwrap();
    assert_eq!(
        meta.cursor_press_intervals.last().unwrap().end,
        f64::INFINITY
    );
    assert_eq!(meta.cursor_samples.len(), metadata().cursor_samples.len());

    // Captions: settings normalized by the editor, cues with and without words.
    assert!(doc.caption_settings.enabled);
    assert_eq!(doc.caption_settings.font_size_px, 38.0);
    assert_eq!(
        doc.caption_settings.sentence_background.as_deref(),
        Some("rgba(8, 8, 10, 0.82)")
    );
    assert_eq!(doc.caption_settings.word_text_color, None);
    assert_eq!(doc.captions.len(), 4);
    assert!(doc.captions[2].words.is_none());
}
