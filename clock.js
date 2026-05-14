function YAClock(selector, options) {
    this.toObject = function (a) {
		if(a instanceof Array) {
			var ret = {}
			for(let i = 0; i < a.length; i++) {
				ret[a[i]]= null;
			}
			return ret;
		}
		return a;
	};
	this.toValue = function (a) {
		return (typeof a  == 'function') ? a.bind(this)() : a;
	};
	
	this.options = Object.assign({
		curveTypes : ["curveNatural"],
		transitionDuration : 1000,
		circleRadii : {HOUR : 50, MINUTE:100, SECOND: 150},
		marks : {HOUR : {attr : {r : 3}}, MINUTE: {attr : {r : 4}}, SECOND: {attr : {r : 5}}},
		dials : ["SECOND"],
		drawCenter : function() {
			return this.svg.append("circle")
		        .attr("cx", this.center[0])
		        .attr("cy", this.center[1])
		        .attr("stroke", "black")
		        .attr("r", this.edgeLength / 80);
		},
		decorate : function() {
		},
		background : function() {
		},
		onSetTime : function() {
		}
	}, options);
	for(const o in this.options) {
		this.options[o] = this.toObject(this.options[o]);
	}
	this.options.onSetTime = this.options.onSetTime.bind(this);
	this.options.decorate = this.options.decorate.bind(this);
	this.options.background = this.options.background.bind(this);
	this.HOUR = 0;
	this.MINUTE = 1;
	this.SECOND = 2;
	this.edgeLength = 400;
	this.units = {HOUR : 12, MINUTE:60, SECOND: 60};
	this.svg = d3.select(selector)
		.append("div")
		.attr("style","display: inline-block; position: relative; width: 100%; padding-bottom: 100%; vertical-align: top; overflow: hidden;")
		.append("svg")
		.attr("preserveAspectRatio", "xMinYMin meet")
		.attr("viewBox", "0 0 "+this.edgeLength+" "+this.edgeLength)
		.attr("width", "100%")
		.attr("style" , "display: inline-block; position: absolute; top: 0px; left: 0;")
	    .attr("height", "100%");
	this.center = [this.edgeLength/2 , this.edgeLength/2];
	
	this.handles = {}

	this.marks = {};
	this.points = {HOUR : this.center, MINUTE : this.center, SECOND : this.center};
	this.lineGens = {};

	this.dHandle = function (ct) {
		let gen = this.lineGens[ct];
		if (!gen) gen = this.lineGens[ct] = d3.line().curve(d3[ct]);
		return gen([
			this.center,
			this.points.HOUR,
			this.points.MINUTE,
			this.points.SECOND
		]);
	};
	
	this.options.background();
	
	for(const ct in this.options.curveTypes) {
		this.handles[ct] = 
		this.svg
		    .append("path")
	  		.attr("d", this.dHandle(ct))
	  		.attr("stroke", "black")
	  		.attr("stroke-linecap", "round")
	  		.attr("fill", ct.indexOf("Closed") > -1 ?"#ccc":"none");
		const cto = this.options.curveTypes[ct];
		if(cto) {
			if(cto.attr){
				for(const a in cto.attr) {
					this.handles[ct].attr(a,cto.attr[a]);
				}
			}
		}
	}
	
	for(const p in this.options.marks) {
		this.marks[p]= this.svg.append("circle")
	                          .attr("cx", this.center[0])
	                          .attr("cy", this.center[1])
	                          .attr("fill", "none")
	                          .attr("stroke", "black")
	                          .attr("r", 5);
		const marko = this.options.marks[p];
		if(marko && marko.attr){
			for(const a in marko.attr) {
				this.marks[p].attr(a,this.toValue(marko.attr[a]));
			}
		}
	}

	this.start = function () {
		this.tick();
		this.stop();
		this.engine = setInterval(this.tick.bind(this), 1000);
	};
	
	this.stop = function () {
		if(this.engine) { clearInterval(this.engine); this.engine = null; }
	};
	
	this._twoPiOverN = {};
	this.cPoint = function (unit, value, radius, center) {
		const k = this._twoPiOverN[unit] || (this._twoPiOverN[unit] = (2 * Math.PI) / unit);
		const a = k * (unit - value) + Math.PI;
		return [
			Math.sin(a) * radius + center[0],
			Math.cos(a) * radius + center[1]
		];
	};
		
	this.animate = function(it, x ,y){
		it.attr("cx", x)
		  .attr("cy", y);
	}	
	
	this.transitionMark = function (r ,value){
		const newPoint = this.cPoint(this.units[r], value, this.options.circleRadii[r], this.center);
		const oldPoint = this.points[r];
		this.points[r] = newPoint;
		if (oldPoint && oldPoint[0] === newPoint[0] && oldPoint[1] === newPoint[1]) return;
		if(this.marks[r]) this.animate(this.transition(this.marks[r]), newPoint[0], newPoint[1]);
	};
	
	this.setSeconds = function (seconds){
		this.now.setSeconds(seconds);
		this.transitionMark("SECOND", seconds);
	};
	
	this.setMinutes = function (minutes){
		this.now.setMinutes(minutes);
		this.transitionMark("MINUTE", minutes);
	};
	
	this.setHours = function (hours){
		this.now.setHours(hours);
		this.transitionMark("HOUR", hours);
	};
	
	this.transition = function (it){
		return it.transition().duration(this.options.transitionDuration);
	};
		
	this.setTime = function (now){	
		this.now = now;
		this.setSeconds(now.getSeconds());
		this.setMinutes(now.getMinutes());
		this.setHours(now.getHours());
		for(const ct in this.options.curveTypes) {
			this.transition(this.handles[ct]).attr("d", this.dHandle(ct))
		}
		this.options.onSetTime();
	};
	
	this.tick = function () {
		this.setTime(new Date());
	};
	
	this.centerCircle = this.options.drawCenter.bind(this)();
	this.options.decorate();

	this.start();

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) this.stop();
		else if (!this.engine) this.start();
	});

	this.defaultDial = function (unit,value, withDetails) {
		var bold = unit == 'HOUR' ? 3 : 5;
		const isDetail = value%bold != 0;
		var length = isDetail ? 2:4;
		if(isDetail && !withDetails) return;
		var p1 = this.cPoint(this.units[unit], value, this.options.circleRadii[unit]-length, this.center);
		var p2 = this.cPoint(this.units[unit], value, this.options.circleRadii[unit]+length, this.center);
		this.svg.append("line")
				.attr("x1", p1[0])
              	.attr("y1", p1[1])
				.attr("x2", p2[0])
              	.attr("y2", p2[1])
              	.attr("stroke-width", (unit != 'HOUR' && isDetail) ? 1:2)
              	.attr("stroke", "black");
	};	 

	for(const unit in this.options.dials) {
		const cfg = this.options.dials[unit];
		if (typeof cfg == 'function') {
			const fn = cfg.bind(this);
			for (let value = 0; value < this.units[unit]; value++) fn(unit, value);
		} else {
			const withDetails = typeof cfg == 'boolean' ? cfg : true;
			const bold = unit == 'HOUR' ? 3 : 5;
			const paths = { 1: "", 2: "" };
			for (let value = 0; value < this.units[unit]; value++) {
				const isDetail = value % bold != 0;
				if (isDetail && !withDetails) continue;
				const length = isDetail ? 2 : 4;
				const sw = (unit != 'HOUR' && isDetail) ? 1 : 2;
				const p1 = this.cPoint(this.units[unit], value, this.options.circleRadii[unit]-length, this.center);
				const p2 = this.cPoint(this.units[unit], value, this.options.circleRadii[unit]+length, this.center);
				paths[sw] += "M" + p1[0] + "," + p1[1] + "L" + p2[0] + "," + p2[1];
			}
			for (const sw in paths) {
				if (paths[sw]) {
					this.svg.append("path")
						.attr("d", paths[sw])
						.attr("fill", "none")
						.attr("stroke", "black")
						.attr("stroke-width", sw);
				}
			}
		}
	};

}