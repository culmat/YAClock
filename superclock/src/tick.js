// rAF loop with Page Visibility pause and wall-clock anchor.

export class TickLoop {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.running = false;
        this.last = 0;
        this.rafId = 0;
        this.boundFrame = this._frame.bind(this);
        this.boundVis = this._onVis.bind(this);
        this.mounted = false;
    }

    mount() {
        if (this.mounted) return;
        this.mounted = true;
        document.addEventListener("visibilitychange", this.boundVis);
        if (!document.hidden) this.start();
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.last = performance.now();
        this.rafId = requestAnimationFrame(this.boundFrame);
    }

    stop() {
        this.running = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
    }

    _onVis() {
        if (document.hidden) this.stop();
        else this.start();
    }

    _frame(t) {
        if (!this.running) return;
        const dt = Math.min(0.1, (t - this.last) / 1000);
        this.last = t;
        this.onFrame(dt, t / 1000);
        this.rafId = requestAnimationFrame(this.boundFrame);
    }

    destroy() {
        this.stop();
        document.removeEventListener("visibilitychange", this.boundVis);
        this.mounted = false;
    }
}
