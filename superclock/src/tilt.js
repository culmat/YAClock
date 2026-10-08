// Pointer / DeviceOrientation -> 3D tilt vector.
// Output: tiltX, tiltY in [-1, 1], smoothed via critically-damped lerp.

export class Tilt {
    constructor(opts = {}) {
        this.opts = { source: "pointer", magnitude: 0.15, smoothing: 0.12, ...opts };
        this.target = [0, 0];
        this.current = [0, 0];
        this._handlers = [];
        this.mounted = false;
    }

    mount(canvas) {
        if (this.mounted || this.opts.source === "none") return;
        this.mounted = true;
        if (this.opts.source === "pointer" || this.opts.source === "auto") {
            const onMove = (e) => {
                const r = canvas.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const x = (e.clientX - cx) / (r.width / 2);
                const y = (e.clientY - cy) / (r.height / 2);
                this.target[0] = Math.max(-1, Math.min(1, x));
                this.target[1] = Math.max(-1, Math.min(1, y));
            };
            const onLeave = () => { this.target[0] = 0; this.target[1] = 0; };
            window.addEventListener("pointermove", onMove, { passive: true });
            window.addEventListener("pointerleave", onLeave, { passive: true });
            this._handlers.push(() => window.removeEventListener("pointermove", onMove));
            this._handlers.push(() => window.removeEventListener("pointerleave", onLeave));
        }
        if (this.opts.source === "gyro" || this.opts.source === "auto") {
            const onOri = (e) => {
                if (e.beta == null || e.gamma == null) return;
                this.target[0] = Math.max(-1, Math.min(1, e.gamma / 45));
                this.target[1] = Math.max(-1, Math.min(1, (e.beta - 30) / 45));
            };
            window.addEventListener("deviceorientation", onOri, { passive: true });
            this._handlers.push(() => window.removeEventListener("deviceorientation", onOri));
        }
    }

    // Step toward target by dt seconds. Returns current [x, y] in [-1, 1].
    update(dt) {
        const k = 1 - Math.exp(-dt / this.opts.smoothing);
        this.current[0] += (this.target[0] - this.current[0]) * k;
        this.current[1] += (this.target[1] - this.current[1]) * k;
        return this.current;
    }

    // Returns mat4 tilt matrix (column-major Float32Array). Ry * Rx.
    matrix() {
        const m = this.opts.magnitude;
        const rx = this.current[1] * m;   // pitch (around X)
        const ry = this.current[0] * m;   // yaw   (around Y)
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        return new Float32Array([
            cy,        0,     -sy,        0,
            sy * sx,   cx,    cy * sx,   0,
            sy * cx,  -sx,    cy * cx,   0,
            0,         0,     0,          1,
        ]);
    }

    destroy() {
        for (const off of this._handlers) off();
        this._handlers = [];
        this.mounted = false;
    }
}
