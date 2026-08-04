//! Physical-pixel crop clamp for area capture.
//!
//! Shared so the rule is testable on every platform and WGC never calls
//! `buffer_crop` with an out-of-range D3D box (driver / whole-PC crash risk).

// WGC is the runtime consumer; on macOS/Linux only unit tests exercise this.
#![cfg_attr(
    not(all(target_os = "windows", feature = "wgc-capture")),
    allow(dead_code)
)]

/// Crop rect in frame-local physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CropPx {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Minimum encodable crop after clamp (matches `encodable_dimensions` floor).
pub const MIN_CROP_SIDE: u32 = 2;

/// Clamp a crop into `[0, frame_w) × [0, frame_h)`. Returns `None` when nothing
/// usable remains.
pub fn clamp_crop_px(crop: CropPx, frame_w: u32, frame_h: u32) -> Option<CropPx> {
    if frame_w < MIN_CROP_SIDE || frame_h < MIN_CROP_SIDE {
        return None;
    }
    if crop.x >= frame_w || crop.y >= frame_h {
        return None;
    }
    let width = crop.width.min(frame_w - crop.x);
    let height = crop.height.min(frame_h - crop.y);
    if width < MIN_CROP_SIDE || height < MIN_CROP_SIDE {
        return None;
    }
    Some(CropPx {
        x: crop.x,
        y: crop.y,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::{clamp_crop_px, CropPx};

    #[test]
    fn clamp_keeps_in_bounds_crop() {
        let c = CropPx {
            x: 100,
            y: 50,
            width: 640,
            height: 360,
        };
        assert_eq!(clamp_crop_px(c, 1920, 1080), Some(c));
    }

    #[test]
    fn clamp_trims_overflow() {
        let c = CropPx {
            x: 1800,
            y: 1000,
            width: 400,
            height: 200,
        };
        assert_eq!(
            clamp_crop_px(c, 1920, 1080),
            Some(CropPx {
                x: 1800,
                y: 1000,
                width: 120,
                height: 80,
            })
        );
    }

    #[test]
    fn clamp_rejects_origin_past_frame() {
        let c = CropPx {
            x: 1920,
            y: 0,
            width: 100,
            height: 100,
        };
        assert_eq!(clamp_crop_px(c, 1920, 1080), None);
    }

    #[test]
    fn clamp_rejects_tiny_remainder() {
        let c = CropPx {
            x: 1919,
            y: 0,
            width: 100,
            height: 100,
        };
        assert_eq!(clamp_crop_px(c, 1920, 1080), None);
    }
}
