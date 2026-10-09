// RGBA → NV12 (BT.709, limited range), tightly packed for the encoder.
// Each invocation converts a 4×2 pixel block: two words of luma (one per row)
// and one word of interleaved chroma (two Cb/Cr pairs, 2×2-averaged).

struct Params {
    width: u32,
    height: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

const KR: f32 = 0.2126;
const KB: f32 = 0.0722;

fn luma(c: vec3<f32>) -> f32 {
    return KR * c.r + (1.0 - KR - KB) * c.g + KB * c.b;
}

fn byte(v: f32) -> u32 {
    return u32(clamp(floor(v * 255.0 + 0.5), 0.0, 255.0));
}

fn y_byte(c: vec3<f32>) -> u32 {
    return byte((16.0 + 219.0 * luma(c)) / 255.0);
}

fn cb_cr(c: vec3<f32>) -> vec2<u32> {
    let y = luma(c);
    let cb = (c.b - y) / (2.0 * (1.0 - KB));
    let cr = (c.r - y) / (2.0 * (1.0 - KR));
    return vec2<u32>(byte((128.0 + 224.0 * cb) / 255.0), byte((128.0 + 224.0 * cr) / 255.0));
}

fn rgb(x: u32, y: u32) -> vec3<f32> {
    // The composite is opaque; drop alpha.
    return textureLoad(src, vec2<i32>(i32(x), i32(y)), 0).rgb;
}

@compute @workgroup_size(16, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let x0 = id.x * 4u;
    let y0 = id.y * 2u;
    if (x0 >= params.width || y0 >= params.height) {
        return;
    }
    var row0: array<vec3<f32>, 4>;
    var row1: array<vec3<f32>, 4>;
    for (var i = 0u; i < 4u; i = i + 1u) {
        row0[i] = rgb(x0 + i, y0);
        row1[i] = rgb(x0 + i, y0 + 1u);
    }
    let w = params.width;
    let y_word0 = y_byte(row0[0]) | (y_byte(row0[1]) << 8u) | (y_byte(row0[2]) << 16u) | (y_byte(row0[3]) << 24u);
    let y_word1 = y_byte(row1[0]) | (y_byte(row1[1]) << 8u) | (y_byte(row1[2]) << 16u) | (y_byte(row1[3]) << 24u);
    out[(y0 * w + x0) / 4u] = y_word0;
    out[((y0 + 1u) * w + x0) / 4u] = y_word1;

    let c0 = cb_cr((row0[0] + row0[1] + row1[0] + row1[1]) * 0.25);
    let c1 = cb_cr((row0[2] + row0[3] + row1[2] + row1[3]) * 0.25);
    let uv_word = c0.x | (c0.y << 8u) | (c1.x << 16u) | (c1.y << 24u);
    let uv_base = (w * params.height) / 4u;
    out[uv_base + ((y0 / 2u) * w + x0) / 4u] = uv_word;
}
