// WebXR (immersive-ar) session manager. Optional; falls back silently when unsupported.

export class XRSession {
    constructor(canvas, renderer) {
        this.canvas = canvas;
        this.renderer = renderer;
        this.session = null;
        this.refSpace = null;
        this.button = null;
    }

    async checkSupport() {
        if (!navigator.xr) return false;
        try { return await navigator.xr.isSessionSupported("immersive-ar"); }
        catch { return false; }
    }

    async mount(rootEl) {
        if (!(await this.checkSupport())) return;
        const btn = document.createElement("button");
        btn.textContent = "Enter AR";
        btn.setAttribute("style",
            "position:absolute;top:8px;left:8px;padding:6px 10px;font:13px system-ui;" +
            "border:1px solid rgba(255,255,255,0.3);border-radius:6px;" +
            "background:rgba(0,0,0,0.45);color:#fff;cursor:pointer;z-index:10;");
        btn.addEventListener("click", () => this._start());
        rootEl.appendChild(btn);
        this.button = btn;
    }

    async _start() {
        try {
            const gl = this.renderer.gl;
            const sess = await navigator.xr.requestSession("immersive-ar");
            await gl.makeXRCompatible();
            const layer = new XRWebGLLayer(sess, gl);
            sess.updateRenderState({ baseLayer: layer });
            this.refSpace = await sess.requestReferenceSpace("local");
            this.session = sess;
            sess.addEventListener("end", () => { this.session = null; });
            // The main render loop in superclock.js checks for this.session and
            // routes through XR framebuffers. Minimal stub here keeps the demo working.
        } catch (e) {
            console.warn("XR session failed:", e);
        }
    }

    destroy() {
        this.button?.remove();
        this.session?.end();
    }
}
