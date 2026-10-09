// One primitive draws every layer: a quad with a rounded-rect coverage mask,
// filled by a solid colour, an RGBA texture, an NV12 video frame, an analytic
// drop shadow or a ring. Output is premultiplied alpha.

struct Draw {
    // Unit quad (0..1)² → draw space (composition px).
    quad_x: vec4<f32>,          // a, b, c, d of the 2×2 linear part
    quad_t: vec4<f32>,          // tx, ty, _, _
    // Draw space → clip space.
    space_x: vec4<f32>,
    space_t: vec4<f32>,
    // Quad-local size in px (mask/shadow space) and corner radius.
    local_size: vec2<f32>,
    radius: f32,
    mode: u32,
    // Source sub-rect in normalized texture coords: origin.xy, size.zw.
    uv_rect: vec4<f32>,
    // Solid colour / tint (premultiplied) and global opacity.
    color: vec4<f32>,
    opacity: f32,
    // NV12: 0 = BT.601, 1 = BT.709, 2 = BT.2020; full range flag.
    yuv_matrix: u32,
    yuv_full_range: u32,
    clip_enabled: u32,
    // Optional rounded clip rect in draw space: x, y, w, h + radius.
    clip_rect: vec4<f32>,
    clip_radius: f32,
    shadow_count: u32,
    _pad0: f32,
    _pad1: f32,
    // Shadow passes: rect in quad-local px (x, y, w, h) …
    shadow_rect: vec4<f32>,
    shadow_radius: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32,
    // … and per pass: sigma, opacity, offset x, offset y.
    shadow_pass: array<vec4<f32>, 3>,
    // Ring: centre x, y (local px), radius, stroke width (0 = filled disc).
    ring: vec4<f32>,
};

@group(0) @binding(0) var<uniform> draw: Draw;
@group(0) @binding(1) var tex_rgba: texture_2d<f32>;
@group(0) @binding(2) var tex_y: texture_2d<f32>;
@group(0) @binding(3) var tex_uv: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) unit: vec2<f32>,
    @location(1) space: vec2<f32>,
};

fn affine(m: vec4<f32>, t: vec4<f32>, p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(m.x * p.x + m.z * p.y + t.x, m.y * p.x + m.w * p.y + t.y);
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VsOut {
    // Two triangles covering the unit quad.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    );
    let unit = corners[index];
    let space = affine(draw.quad_x, draw.quad_t, unit);
    let clip = affine(draw.space_x, draw.space_t, space);
    var out: VsOut;
    out.position = vec4<f32>(clip, 0.0, 1.0);
    out.unit = unit;
    out.space = space;
    return out;
}

// Signed distance to a rounded rect of half-size `half` centred at the origin.
fn rounded_rect_sdf(p: vec2<f32>, half: vec2<f32>, radius: f32) -> f32 {
    let r = min(radius, min(half.x, half.y));
    let q = abs(p) - half + vec2<f32>(r, r);
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Anti-aliased coverage of the shape whose SDF is `d`.
fn coverage(d: f32) -> f32 {
    let aa = max(fwidth(d), 1e-4);
    return clamp(0.5 - d / aa, 0.0, 1.0);
}

fn yuv_to_rgb(y_raw: f32, uv_raw: vec2<f32>) -> vec3<f32> {
    var y = y_raw;
    var uv = uv_raw - vec2<f32>(0.5, 0.5);
    if (draw.yuv_full_range == 0u) {
        y = (y_raw - 16.0 / 255.0) * (255.0 / 219.0);
        uv = (uv_raw - vec2<f32>(128.0 / 255.0, 128.0 / 255.0)) * (255.0 / 224.0);
    }
    // Kr, Kb per matrix.
    var kr = 0.299;
    var kb = 0.114;
    if (draw.yuv_matrix == 1u) {
        kr = 0.2126;
        kb = 0.0722;
    } else if (draw.yuv_matrix == 2u) {
        kr = 0.2627;
        kb = 0.0593;
    }
    let kg = 1.0 - kr - kb;
    let r = y + 2.0 * (1.0 - kr) * uv.y;
    let b = y + 2.0 * (1.0 - kb) * uv.x;
    let g = (y - kr * r - kb * b) / kg;
    return clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Abramowitz–Stegun 7.1.27 (|error| < 5e-4) — plenty for a soft shadow.
fn erf2(x: vec2<f32>) -> vec2<f32> {
    let s = sign(x);
    let a = abs(x);
    var t = 1.0 + (0.278393 + (0.230389 + (0.000972 + 0.078108 * a) * a) * a) * a;
    t = t * t;
    return s - s / (t * t);
}

fn gaussian(x: f32, sigma: f32) -> f32 {
    return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066282746 * sigma);
}

// Horizontal integral of a blurred rounded box at height y.
fn shadow_x(x: f32, y: f32, sigma: f32, corner: f32, half: vec2<f32>) -> f32 {
    let delta = min(half.y - corner - abs(y), 0.0);
    let curved = half.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
    let integral = 0.5 + 0.5 * erf2((x + vec2<f32>(-curved, curved)) * (0.70710678 / sigma));
    return integral.y - integral.x;
}

// Gaussian(σ) blur of a filled rounded rect, evaluated at `p` (rect-centred).
fn blurred_box(p: vec2<f32>, half: vec2<f32>, sigma: f32, corner: f32) -> f32 {
    if (sigma < 0.05) {
        return clamp(0.5 - rounded_rect_sdf(p, half, corner), 0.0, 1.0);
    }
    let low = p.y - half.y;
    let high = p.y + half.y;
    let start = clamp(-3.0 * sigma, low, high);
    let stop = clamp(3.0 * sigma, low, high);
    let step = (stop - start) / 8.0;
    var y = start + step * 0.5;
    var value = 0.0;
    for (var i = 0; i < 8; i = i + 1) {
        value = value + shadow_x(p.x, p.y - y, sigma, corner, half) * gaussian(y, sigma) * step;
        y = y + step;
    }
    return value;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let local = in.unit * draw.local_size;
    let half = draw.local_size * 0.5;

    // Shape coverage: the quad's own rounded rect (shadows and rings draw
    // their own geometry and skip it).
    var cover = 1.0;
    if (draw.mode != 3u && draw.mode != 4u && draw.radius > 0.0) {
        cover = coverage(rounded_rect_sdf(local - half, half, draw.radius));
    }
    if (draw.clip_enabled != 0u) {
        let c = draw.clip_rect;
        let ch = c.zw * 0.5;
        cover = cover * coverage(rounded_rect_sdf(in.space - (c.xy + ch), ch, draw.clip_radius));
    }

    let uv = draw.uv_rect.xy + in.unit * draw.uv_rect.zw;
    var color = vec4<f32>(0.0);
    switch (draw.mode) {
        case 0u: {
            color = draw.color;
        }
        case 1u: {
            color = textureSampleLevel(tex_rgba, samp, uv, 0.0) * draw.color.a;
        }
        case 2u: {
            let y = textureSampleLevel(tex_y, samp, uv, 0.0).r;
            let c = textureSampleLevel(tex_uv, samp, uv, 0.0).rg;
            color = vec4<f32>(yuv_to_rgb(y, c), 1.0);
        }
        case 3u: {
            let sr = draw.shadow_rect;
            let sh = sr.zw * 0.5;
            var keep = 1.0;
            for (var i = 0u; i < draw.shadow_count; i = i + 1u) {
                let pass_ = draw.shadow_pass[i];
                let p = local - (sr.xy + sh) - pass_.zw;
                keep = keep * (1.0 - pass_.y * blurred_box(p, sh, pass_.x, draw.shadow_radius));
            }
            color = vec4<f32>(0.0, 0.0, 0.0, 1.0 - keep);
        }
        case 4u: {
            let d = length(local - draw.ring.xy) - draw.ring.z;
            var ring_cover = 0.0;
            if (draw.ring.w > 0.0) {
                ring_cover = coverage(abs(d) - draw.ring.w * 0.5);
            } else {
                ring_cover = coverage(d);
            }
            color = draw.color * ring_cover;
        }
        default: {
            color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
        }
    }
    return color * (cover * draw.opacity);
}
