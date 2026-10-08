// All GLSL ES 3.00 sources. Kept inline so the project needs no build step.

const HEAD = "#version 300 es\nprecision highp float;\n";

export const faceVS = HEAD + `
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const faceFS = HEAD + `
in vec2 v_uv;
uniform float u_time;
uniform vec3 u_bg;
uniform vec3 u_accent;
uniform int u_astro;
uniform vec2 u_daylightArc;   // [start, end] in radians, 0 = midnight at top, clockwise
uniform float u_moonPhase;    // 0..1
uniform float u_moonIllum;    // 0..1
uniform vec2 u_sunDot;        // sun-position dot (xy in [-1,1]), or (-2,-2) if hidden
out vec4 frag;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

void main() {
    float r = length(v_uv);
    vec3 col = mix(u_bg * 1.15, u_bg * 0.55, smoothstep(0.0, 1.2, r));
    col += (noise(v_uv * 6.0 + u_time * 0.05) - 0.5) * 0.03;

    if (u_astro == 1) {
        // 24h angle: convert v_uv direction to [0, 2pi), 0 = up (12 o'clock midnight)
        float ang = atan(v_uv.x, -v_uv.y);
        if (ang < 0.0) ang += 6.2831853;
        float a = u_daylightArc.x, b = u_daylightArc.y;
        float inDay = step(a, ang) * step(ang, b);
        // band at radius ~0.88
        float bandMask = smoothstep(0.86, 0.88, r) * (1.0 - smoothstep(0.92, 0.94, r));
        col = mix(col, col + u_accent * 0.6, inDay * bandMask);

        // Moon glyph opposite 12 (bottom of dial)
        vec2 moonPos = vec2(0.0, 0.72);
        float md = length(v_uv - moonPos);
        if (md < 0.08) {
            float disk = smoothstep(0.08, 0.07, md);
            // crescent: shift a darker disk by phase
            float shift = (u_moonPhase < 0.5 ? -1.0 : 1.0) * 0.05;
            float md2 = length(v_uv - moonPos - vec2(shift * (1.0 - u_moonIllum * 2.0), 0.0));
            float shadow = smoothstep(0.075, 0.07, md2);
            vec3 moonCol = mix(vec3(0.85, 0.85, 0.9), vec3(0.2), shadow);
            col = mix(col, moonCol, disk);
        }
        // Sun dot
        if (u_sunDot.x > -1.5) {
            float sd = length(v_uv - u_sunDot);
            float s = smoothstep(0.035, 0.0, sd);
            col += vec3(1.5, 1.1, 0.4) * s;
        }
    }
    frag = vec4(col, 1.0);
}`;

// Dial: instanced quad per tick. Per-instance: vec4 (angle, radius, length, bold)
export const dialVS = HEAD + `
in vec2 a_quad;          // unit quad in [-1, 1]
in vec4 a_inst;          // (angle, radius, length, bold)
uniform vec2 u_invHalfEdge; // scale to clip space
out float v_bold;
void main() {
    float ang = a_inst.x, r = a_inst.y, len = a_inst.z;
    v_bold = a_inst.w;
    float width = mix(0.0025, 0.005, a_inst.w);
    vec2 along = vec2(sin(ang), cos(ang));
    vec2 perp  = vec2(along.y, -along.x);
    vec2 local = along * (r + a_quad.y * len) + perp * (a_quad.x * width);
    gl_Position = vec4(local * u_invHalfEdge, 0.0, 1.0);
}`;

export const dialFS = HEAD + `
in float v_bold;
uniform vec3 u_color;
out vec4 frag;
void main() {
    frag = vec4(u_color * mix(0.65, 1.0, v_bold), 1.0);
}`;

// Hand: thick ribbon (triangle strip) through curve samples.
// Per-vertex: vec2 pos (pre-extruded clip-space).
export const handVS = HEAD + `
in vec2 a_pos;
in float a_t;            // 0..1 along the ribbon
uniform mat4 u_tilt;
out float v_t;
void main() {
    v_t = a_t;
    vec4 p = u_tilt * vec4(a_pos, 0.0, 1.0);
    gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const handFS = HEAD + `
in float v_t;
uniform vec3 u_color;
uniform float u_glowTip;
out vec4 frag;
void main() {
    vec3 c = u_color;
    // Brighter at the tip; HDR-friendly so bloom picks it up.
    float tip = smoothstep(0.6, 1.0, v_t) * u_glowTip;
    c += vec3(1.2, 0.9, 0.7) * tip;
    frag = vec4(c, 1.0);
}`;

// Bloom: full-screen passes.
export const fsQuadVS = HEAD + `
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const bloomThresholdFS = HEAD + `
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
out vec4 frag;
void main() {
    vec3 c = texture(u_src, v_uv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = max(0.0, lum - u_threshold);
    frag = vec4(c * smoothstep(0.0, 0.2, k), 1.0);
}`;

export const bloomBlurFS = HEAD + `
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_dir;
out vec4 frag;
void main() {
    vec2 px = u_dir / vec2(textureSize(u_src, 0));
    vec3 c = texture(u_src, v_uv).rgb * 0.227;
    c += texture(u_src, v_uv + px * 1.0).rgb * 0.194;
    c += texture(u_src, v_uv - px * 1.0).rgb * 0.194;
    c += texture(u_src, v_uv + px * 2.0).rgb * 0.121;
    c += texture(u_src, v_uv - px * 2.0).rgb * 0.121;
    c += texture(u_src, v_uv + px * 3.0).rgb * 0.054;
    c += texture(u_src, v_uv - px * 3.0).rgb * 0.054;
    c += texture(u_src, v_uv + px * 4.0).rgb * 0.016;
    c += texture(u_src, v_uv - px * 4.0).rgb * 0.016;
    frag = vec4(c, 1.0);
}`;

// ACES tonemap: combine scene + bloom, output sRGB-ish.
export const tonemapFS = HEAD + `
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomIntensity;
out vec4 frag;
vec3 aces(vec3 x) {
    float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
void main() {
    vec3 scene = texture(u_scene, v_uv).rgb;
    vec3 bloom = texture(u_bloom, v_uv).rgb;
    vec3 col = scene + bloom * u_bloomIntensity;
    col = aces(col);
    col = pow(col, vec3(1.0 / 2.2));
    frag = vec4(col, 1.0);
}`;
