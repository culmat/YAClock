// SVG overlay + D3 facade. Lets `this.svg` continue to work for legacy
// user callbacks (drawCenter, decorate, background, custom dials, onSetTime).

export class SVGOverlay {
    constructor(d3, parent, edgeLength) {
        this.d3 = d3;
        this.edgeLength = edgeLength;
        this.svg = d3.select(parent)
            .append("svg")
            .attr("preserveAspectRatio", "xMinYMin meet")
            .attr("viewBox", `0 0 ${edgeLength} ${edgeLength}`)
            .attr("style", "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;")
            .attr("width", "100%")
            .attr("height", "100%");
        this.marks = {};
    }

    addMark(unit, center, attrs, toValue) {
        const m = this.svg.append("circle")
            .attr("cx", center[0])
            .attr("cy", center[1])
            .attr("fill", "none")
            .attr("stroke", "rgba(255,255,255,0.85)")
            .attr("r", 5);
        if (attrs) for (const k in attrs) m.attr(k, toValue(attrs[k]));
        this.marks[unit] = m;
        return m;
    }

    transitionMark(unit, point, duration) {
        const m = this.marks[unit];
        if (!m) return;
        m.transition().duration(duration).attr("cx", point[0]).attr("cy", point[1]);
    }

    transition(sel, duration) {
        return sel.transition().duration(duration);
    }

    // Build optimized dial paths (re-uses the path-collapse approach from clock.js).
    drawDefaultDial(unit, units, center, radius, withDetails, cPoint) {
        const bold = unit === "HOUR" ? 3 : 5;
        const paths = { 1: "", 2: "" };
        for (let value = 0; value < units; value++) {
            const isDetail = value % bold !== 0;
            if (isDetail && !withDetails) continue;
            const length = isDetail ? 2 : 4;
            const sw = (unit !== "HOUR" && isDetail) ? 1 : 2;
            const p1 = cPoint(units, value, radius - length, center);
            const p2 = cPoint(units, value, radius + length, center);
            paths[sw] += `M${p1[0]},${p1[1]}L${p2[0]},${p2[1]}`;
        }
        for (const sw in paths) {
            if (paths[sw]) {
                this.svg.append("path")
                    .attr("d", paths[sw])
                    .attr("fill", "none")
                    .attr("stroke", "rgba(255,255,255,0.55)")
                    .attr("stroke-width", sw);
            }
        }
    }

    destroy() {
        this.svg.remove();
    }
}
