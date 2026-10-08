// WebAudio synthesis: hour chime + optional second tick.
// Autoplay-policy compliant: requires a user gesture to start AudioContext.

export class ClockAudio {
    constructor(opts = {}) {
        this.opts = { hourChime: true, secondTick: false, volume: 0.4, ...opts };
        this.ctx = null;
        this.master = null;
        this.enableButton = null;
        this._onReady = [];
    }

    isReady() { return this.ctx && this.ctx.state === "running"; }

    // Attach a one-time gesture handler that resumes/creates the AudioContext.
    // Displays an enable button overlay on the given root element.
    mount(rootEl) {
        if (this.isReady()) return;
        const btn = document.createElement("button");
        btn.textContent = "🔔 Enable sound";
        btn.setAttribute("style",
            "position:absolute;top:8px;right:8px;padding:6px 10px;font:13px system-ui;" +
            "border:1px solid rgba(255,255,255,0.3);border-radius:6px;" +
            "background:rgba(0,0,0,0.45);color:#fff;cursor:pointer;z-index:10;");
        btn.addEventListener("click", () => this._resume(btn));
        rootEl.appendChild(btn);
        this.enableButton = btn;
    }

    async _resume(btn) {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) { btn?.remove(); return; }
            this.ctx = new Ctx();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.opts.volume;
            this.master.connect(this.ctx.destination);
        }
        await this.ctx.resume();
        btn?.remove();
        this.enableButton = null;
        for (const fn of this._onReady) fn();
        this._onReady = [];
    }

    onReady(fn) {
        if (this.isReady()) fn();
        else this._onReady.push(fn);
    }

    // Bell-like tone: additive sine harmonics + exponential envelope.
    playBell(freq = 440, duration = 1.4) {
        if (!this.isReady()) return;
        const t = this.ctx.currentTime;
        const harmonics = [
            { mul: 1.0, gain: 1.0 },
            { mul: 2.01, gain: 0.55 },
            { mul: 2.99, gain: 0.32 },
            { mul: 4.02, gain: 0.18 },
            { mul: 5.71, gain: 0.09 }
        ];
        const out = this.ctx.createGain();
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(0.9, t + 0.005);
        out.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        out.connect(this.master);
        for (const h of harmonics) {
            const osc = this.ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = freq * h.mul;
            const g = this.ctx.createGain();
            g.gain.value = h.gain;
            osc.connect(g).connect(out);
            osc.start(t);
            osc.stop(t + duration + 0.05);
        }
    }

    playHourChime(hour12) {
        if (!this.opts.hourChime || !this.isReady()) return;
        const beats = Math.max(1, Math.min(12, hour12 % 12 || 12));
        const baseFreq = 392; // G4
        for (let i = 0; i < beats; i++) {
            setTimeout(() => this.playBell(baseFreq * (1 + i * 0.005), 1.6), i * 600);
        }
    }

    playSecondTick() {
        if (!this.opts.secondTick || !this.isReady()) return;
        const t = this.ctx.currentTime;
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.04, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        const src = this.ctx.createBufferSource(); src.buffer = buf;
        const bp = this.ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = 3000; bp.Q.value = 4;
        const g = this.ctx.createGain(); g.gain.value = 0.25;
        src.connect(bp).connect(g).connect(this.master);
        src.start(t);
    }

    destroy() {
        this.enableButton?.remove();
        if (this.ctx) this.ctx.close();
    }
}
