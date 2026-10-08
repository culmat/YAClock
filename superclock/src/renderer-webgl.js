// WebGL2 renderer for SuperClock.
// Pipeline: face -> dials -> hands -> bloom (threshold + blur ping-pong) -> tonemap.

import * as S from "./shaders.js";

const HAND_SAMPLES = 48;        // samples along a Catmull-Rom curve per hand
const HAND_WIDTH = 0.012;       // ribbon half-width in clip space

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        console.error("Shader compile error:\n" + log + "\n--- source ---\n" + src);
        throw new Error(log);
    }
    return sh;
}
function link(gl, vsSrc, fsSrc, attribBindings) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    if (attribBindings) {
        for (const name in attribBindings) gl.bindAttribLocation(p, attribBindings[name], name);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error("Link error: " + gl.getProgramInfoLog(p));
    }
    const attrs = {}, unis = {};
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) {
        const a = gl.getActiveAttrib(p, i);
        attrs[a.name] = gl.getAttribLocation(p, a.name);
    }
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
        const u = gl.getActiveUniform(p, i);
        unis[u.name] = gl.getUniformLocation(p, u.name);
    }
    return { p, a: attrs, u: unis };
}

// Catmull-Rom sampling through control points; returns 2D Float32Array of length samples*2.
function sampleCurve(points, samples, closed) {
    const pts = closed ? [...points, points[0]] : points;
    const segs = pts.length - 1;
    const out = new Float32Array(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = (i / (samples - 1)) * segs;
        const seg = Math.min(segs - 1, Math.floor(t));
        const u = t - seg;
        const p0 = pts[Math.max(0, seg - 1)];
        const p1 = pts[seg];
        const p2 = pts[seg + 1];
        const p3 = pts[Math.min(segs, seg + 2)];
        const u2 = u * u, u3 = u2 * u;
        // Centripetal-ish Catmull-Rom with tension 0.5
        for (let k = 0; k < 2; k++) {
            const c0 = 2 * p1[k];
            const c1 = -p0[k] + p2[k];
            const c2 = 2*p0[k] - 5*p1[k] + 4*p2[k] - p3[k];
            const c3 = -p0[k] + 3*p1[k] - 3*p2[k] + p3[k];
            out[i*2+k] = 0.5 * (c0 + c1*u + c2*u2 + c3*u3);
        }
    }
    return out;
}

// Build triangle strip ribbon from a polyline (Float32Array of xy pairs). Returns (positions, ts).
function ribbon(samples, halfWidth) {
    const n = samples.length / 2;
    const pos = new Float32Array(n * 2 * 2);     // 2 verts per sample
    const ts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const x = samples[i*2], y = samples[i*2+1];
        let tx, ty;
        if (i === 0) { tx = samples[2] - x; ty = samples[3] - y; }
        else if (i === n - 1) { tx = x - samples[(i-1)*2]; ty = y - samples[(i-1)*2+1]; }
        else { tx = samples[(i+1)*2] - samples[(i-1)*2]; ty = samples[(i+1)*2+1] - samples[(i-1)*2+1]; }
        const len = Math.hypot(tx, ty) || 1;
        const nx = -ty / len * halfWidth, ny = tx / len * halfWidth;
        pos[i*4+0] = x + nx; pos[i*4+1] = y + ny;
        pos[i*4+2] = x - nx; pos[i*4+3] = y - ny;
        const t = i / (n - 1);
        ts[i*2] = t; ts[i*2+1] = t;
    }
    return { pos, ts };
}

export class WebGLRenderer {
    constructor(canvas, opts) {
        this.canvas = canvas;
        this.opts = opts;
        const gl = canvas.getContext("webgl2", {
            premultipliedAlpha: true, antialias: true, alpha: true
        });
        if (!gl) throw new Error("WebGL2 not supported");
        this.gl = gl;
        this.hdr = !!gl.getExtension("EXT_color_buffer_float");
        this.handBuffers = {}; // curveType -> {vbo, ts, count}
        this._initPrograms();
        this._initStaticBuffers();
        this._initFramebuffers();
        this.size = [1, 1];
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    }

    _initPrograms() {
        const gl = this.gl;
        // Pin attribute locations so a single VAO can be shared across programs
        // that consume the same attribute layout.
        this.progFace     = link(gl, S.faceVS, S.faceFS,             { a_pos: 0 });
        this.progDial     = link(gl, S.dialVS, S.dialFS,             { a_quad: 0, a_inst: 1 });
        this.progHand     = link(gl, S.handVS, S.handFS,             { a_pos: 0, a_t: 1 });
        this.progThresh   = link(gl, S.fsQuadVS, S.bloomThresholdFS, { a_pos: 0 });
        this.progBlur     = link(gl, S.fsQuadVS, S.bloomBlurFS,      { a_pos: 0 });
        this.progTonemap  = link(gl, S.fsQuadVS, S.tonemapFS,        { a_pos: 0 });
    }

    _initStaticBuffers() {
        const gl = this.gl;
        // Full-screen quad
        this.quadVAO = gl.createVertexArray();
        gl.bindVertexArray(this.quadVAO);
        this.quadVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1,  1,-1,  -1,1,
             1,-1,  1, 1,  -1,1,
        ]), gl.STATIC_DRAW);
        const facePosLoc = this.progFace.a.a_pos;
        gl.enableVertexAttribArray(facePosLoc);
        gl.vertexAttribPointer(facePosLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        // Dial: unit quad + instance buffer
        this.dialQuadVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dialQuadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, 0,  1, 0,  -1, 1,
             1, 0,  1, 1,  -1, 1,
        ]), gl.STATIC_DRAW);
        this.dialInstanceVBOs = {}; // unit -> { vbo, count }
        this.dialVAOs = {};
    }

    _makeTexture(w, h, internalFormat, format, type) {
        const gl = this.gl;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    _initFramebuffers() {
        // Created on first resize.
        this.fbScene = null; this.texScene = null;
        this.fbBloom = [null, null]; this.texBloom = [null, null];
        this._fbSize = [0, 0];
    }

    _ensureFramebuffers() {
        const gl = this.gl;
        const w = this.canvas.width, h = this.canvas.height;
        if (w === this._fbSize[0] && h === this._fbSize[1] && this.fbScene) return;
        this._fbSize = [w, h];
        const intF = this.hdr ? gl.RGBA16F : gl.RGBA8;
        const typ  = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

        if (this.fbScene) gl.deleteFramebuffer(this.fbScene);
        if (this.texScene) gl.deleteTexture(this.texScene);
        this.texScene = this._makeTexture(w, h, intF, gl.RGBA, typ);
        this.fbScene = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbScene);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texScene, 0);

        const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
        for (let i = 0; i < 2; i++) {
            if (this.fbBloom[i]) gl.deleteFramebuffer(this.fbBloom[i]);
            if (this.texBloom[i]) gl.deleteTexture(this.texBloom[i]);
            this.texBloom[i] = this._makeTexture(bw, bh, intF, gl.RGBA, typ);
            this.fbBloom[i] = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBloom[i]);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBloom[i], 0);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._bloomSize = [bw, bh];
    }

    resize() {
        const r = this.canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(r.width * dpr));
        const h = Math.max(1, Math.floor(r.height * dpr));
        if (w !== this.canvas.width || h !== this.canvas.height) {
            this.canvas.width = w; this.canvas.height = h;
        }
        this.size = [w, h];
        this.dpr = dpr;
        this._ensureFramebuffers();
    }

    // Update dial geometry for a unit. instances: array of {angle, radius, length, bold}.
    setDial(unit, instances) {
        const gl = this.gl;
        const data = new Float32Array(instances.length * 4);
        for (let i = 0; i < instances.length; i++) {
            const it = instances[i];
            data[i*4+0] = it.angle;
            data[i*4+1] = it.radius;
            data[i*4+2] = it.length;
            data[i*4+3] = it.bold ? 1.0 : 0.0;
        }
        let entry = this.dialInstanceVBOs[unit];
        if (!entry) {
            const vbo = gl.createBuffer();
            const vao = gl.createVertexArray();
            entry = this.dialInstanceVBOs[unit] = { vbo, vao, count: 0 };
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.dialQuadVBO);
            gl.enableVertexAttribArray(this.progDial.a.a_quad);
            gl.vertexAttribPointer(this.progDial.a.a_quad, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.enableVertexAttribArray(this.progDial.a.a_inst);
            gl.vertexAttribPointer(this.progDial.a.a_inst, 4, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.progDial.a.a_inst, 1);
            gl.bindVertexArray(null);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        entry.count = instances.length;
    }

    // Rebuild a hand ribbon. points: array of [x,y] in clip space [-1..1].
    setHand(curveType, points, closed) {
        const gl = this.gl;
        const samples = sampleCurve(points, HAND_SAMPLES, closed);
        const { pos, ts } = ribbon(samples, HAND_WIDTH);
        let h = this.handBuffers[curveType];
        if (!h) {
            const posVBO = gl.createBuffer();
            const tVBO = gl.createBuffer();
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, posVBO);
            gl.enableVertexAttribArray(this.progHand.a.a_pos);
            gl.vertexAttribPointer(this.progHand.a.a_pos, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, tVBO);
            gl.enableVertexAttribArray(this.progHand.a.a_t);
            gl.vertexAttribPointer(this.progHand.a.a_t, 1, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);
            h = this.handBuffers[curveType] = { posVBO, tVBO, vao, count: 0 };
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, h.posVBO);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, h.tVBO);
        gl.bufferData(gl.ARRAY_BUFFER, ts, gl.DYNAMIC_DRAW);
        h.count = pos.length / 2;
    }

    render(state) {
        const gl = this.gl;
        this.resize();
        gl.viewport(0, 0, this.size[0], this.size[1]);

        // ---- Scene pass ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbScene);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // Face
        gl.useProgram(this.progFace.p);
        gl.uniform1f(this.progFace.u.u_time, state.time);
        gl.uniform3fv(this.progFace.u.u_bg, state.bg);
        gl.uniform3fv(this.progFace.u.u_accent, state.accent);
        gl.uniform1i(this.progFace.u.u_astro, state.astro ? 1 : 0);
        gl.uniform2fv(this.progFace.u.u_daylightArc, state.daylightArc || [0, 0]);
        gl.uniform1f(this.progFace.u.u_moonPhase, state.moonPhase || 0);
        gl.uniform1f(this.progFace.u.u_moonIllum, state.moonIllum || 0);
        gl.uniform2fv(this.progFace.u.u_sunDot, state.sunDot || [-2, -2]);
        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Dials
        gl.useProgram(this.progDial.p);
        gl.uniform2fv(this.progDial.u.u_invHalfEdge, [1, 1]); // points are already in clip space
        gl.uniform3fv(this.progDial.u.u_color, state.dialColor);
        for (const unit in this.dialInstanceVBOs) {
            const e = this.dialInstanceVBOs[unit];
            if (!e.count) continue;
            gl.bindVertexArray(e.vao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, e.count);
        }

        // Hands
        gl.useProgram(this.progHand.p);
        gl.uniformMatrix4fv(this.progHand.u.u_tilt, false, state.tiltMatrix);
        gl.uniform3fv(this.progHand.u.u_color, state.handColor);
        gl.uniform1f(this.progHand.u.u_glowTip, state.handGlow);
        for (const ct in this.handBuffers) {
            const h = this.handBuffers[ct];
            if (!h.count) continue;
            gl.bindVertexArray(h.vao);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, h.count);
        }

        // ---- Bloom: threshold + blur ping-pong ----
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, this._bloomSize[0], this._bloomSize[1]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBloom[0]);
        gl.useProgram(this.progThresh.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texScene);
        gl.uniform1i(this.progThresh.u.u_src, 0);
        gl.uniform1f(this.progThresh.u.u_threshold, state.bloomThreshold);
        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.useProgram(this.progBlur.p);
        for (let i = 0; i < 2; i++) {
            // horizontal
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBloom[1]);
            gl.bindTexture(gl.TEXTURE_2D, this.texBloom[0]);
            gl.uniform1i(this.progBlur.u.u_src, 0);
            gl.uniform2fv(this.progBlur.u.u_dir, [1, 0]);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            // vertical
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBloom[0]);
            gl.bindTexture(gl.TEXTURE_2D, this.texBloom[1]);
            gl.uniform2fv(this.progBlur.u.u_dir, [0, 1]);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        // ---- Tonemap to default framebuffer ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.size[0], this.size[1]);
        gl.useProgram(this.progTonemap.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texScene);
        gl.uniform1i(this.progTonemap.u.u_scene, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texBloom[0]);
        gl.uniform1i(this.progTonemap.u.u_bloom, 1);
        gl.uniform1f(this.progTonemap.u.u_bloomIntensity, state.bloomIntensity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.bindVertexArray(null);
    }

    destroy() {
        const gl = this.gl;
        for (const k in this.handBuffers) {
            const h = this.handBuffers[k];
            gl.deleteBuffer(h.posVBO); gl.deleteBuffer(h.tVBO); gl.deleteVertexArray(h.vao);
        }
        for (const k in this.dialInstanceVBOs) {
            const e = this.dialInstanceVBOs[k];
            gl.deleteBuffer(e.vbo); gl.deleteVertexArray(e.vao);
        }
        gl.deleteBuffer(this.quadVBO); gl.deleteVertexArray(this.quadVAO);
        if (this.fbScene) gl.deleteFramebuffer(this.fbScene);
        for (let i = 0; i < 2; i++) {
            if (this.fbBloom[i]) gl.deleteFramebuffer(this.fbBloom[i]);
            if (this.texBloom[i]) gl.deleteTexture(this.texBloom[i]);
        }
        if (this.texScene) gl.deleteTexture(this.texScene);
    }
}
