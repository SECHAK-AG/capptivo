// One direction of a separable Gaussian blur over premultiplied RGBA.
// Reads clamp to the source edge, which matches the editor's edge-extended
// background blur; blur regions carry transparent padding instead.

struct Blur {
    // Texel step for one tap, in texels (1,0) or (0,1).
    direction: vec2<i32>,
    radius: i32,
    sigma: f32,
};

@group(0) @binding(0) var<uniform> params: Blur;
@group(0) @binding(1) var src: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    // Fullscreen triangle.
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(src));
    let origin = vec2<i32>(position.xy);
    var sum = vec4<f32>(0.0);
    var weight = 0.0;
    let denom = 2.0 * params.sigma * params.sigma;
    for (var i = -params.radius; i <= params.radius; i = i + 1) {
        let p = clamp(origin + params.direction * i, vec2<i32>(0), size - vec2<i32>(1));
        let w = exp(-f32(i * i) / denom);
        sum = sum + textureLoad(src, p, 0) * w;
        weight = weight + w;
    }
    return sum / weight;
}
