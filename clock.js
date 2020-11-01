function YAClock(selector, options) {
    this.options = Object.assign({
		curveTypes : ["curveNatural"],
		circleRadii : {HOUR : 50, MINUTE:100, SECOND: 150},
		marks : {HOUR : 3, MINUTE:4, SECOND: 5}
	}, options);
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
	
	this.centerCircle = this.svg.append("circle")
	        .attr("cx", this.center[0])
	        .attr("cy", this.center[1])
	        .attr("stroke", "black")
	        .attr("r", 5);

	this.handles = []
	for(i = 0; i < this.options.curveTypes.length; i++) {
		this.handles.push(
		this.svg
		    .append("path")
	  		.attr("d", d3.line().curve()([
				this.center, 
				this.center
			]))
	  		.attr("stroke", "black")
	  		.attr("fill", "none"));
	}

	this.circles = {};
	this.points = {};
	
	for(const p in this.options.marks) {
		this.circles[p]= this.svg.append("circle")
	                          .attr("cx", this.center[0])
	                          .attr("cy", this.center[1])
	                          .attr("fill", "none")
	                          .attr("stroke", "black")
	                          .attr("r", this.options.marks[p]);
	}

	this.start = function () {
		this.tick();
		this.stop();
		this.engine = setInterval(this.tick.bind(this), 1000);
	};
	
	this.stop = function () {
		if(this.engine) clearInterval(this.engine);
	};
	
	this.cPoint = function (unit, value, radius, center) {
		value = unit - value;
		return [
			(Math.sin(Math.PI*2/unit*value+Math.PI))*radius+center[0],
			(Math.cos(Math.PI*2/unit*value+Math.PI))*radius+center[1]
		]
	};
	
	this.dHandle = function (i) {
		// curveNatural
		// curveStepAfter
		return d3.line().curve(d3[this.options.curveTypes[i]])([
			this.center, 
			this.points.HOUR, 
			this.points.MINUTE,
			this.points.SECOND 
		]);
	};
	
	this.animate = function(it, x ,y){
		it.attr("cx", x)
		  .attr("cy", y);
	}	
	
	this.transitionCircle = function (r ,value){
		this.points[r] = this.cPoint(this.units[r], value, this.options.circleRadii[r], this.center)
		if(this.circles[r]) this.animate(this.transition(this.circles[r]), this.points[r][0],this.points[r][1]);
	};
	
	this.setSeconds = function (seconds){
		this.now.setSeconds(seconds);
		this.transitionCircle("SECOND", seconds);
	};
	
	this.setMinutes = function (minutes){
		this.now.setMinutes(minutes);
		this.transitionCircle("MINUTE", minutes);
	};
	
	this.setHours = function (hours){
		this.now.setHours(hours);
		this.transitionCircle("HOUR", hours);
	};
	
	this.transition = function (it){
		return it.transition().duration(1000);
	};
		
	this.setTime = function (now){	
		this.now = now;
		this.setSeconds(now.getSeconds());
		this.setMinutes(now.getMinutes());
		this.setHours(now.getHours());
		for(i = 0; i < this.options.curveTypes.length; i++) {
			this.transition(this.handles[i]).attr("d", this.dHandle(i))
		}
	};
	
	this.tick = function () {
		this.setTime(new Date());
	};
	
	this.start();
	this.svg.append("rect")
      .attr("x", 1)
      .attr("y", 1)
	  .attr("fill", "none")
	  .attr("stroke", "black")
      .attr("width",this.edgeLength-2)
      .attr("height", this.edgeLength-2);

	 
	["SECOND"].forEach((function(r){  
		for (i = 0; i < this.units[r]; i++) {
			var length = i%5 == 0 ? 4:2;
			if(length > 2) {
				var p1 = this.cPoint(this.units[r], i, this.options.circleRadii[r]-length, this.center);
				var p2 = this.cPoint(this.units[r], i, this.options.circleRadii[r]+length, this.center);
				this.svg.append("line")
						.attr("x1", p1[0])
		              	.attr("y1", p1[1])
						.attr("x2", p2[0])
		              	.attr("y2", p2[1])
		              	.attr("stroke-width", (r == 0 || i%5 == 0) ? 2:1)
		              	.attr("stroke", "black");
			}
		}
	}).bind(this) );
	/*
	for (r = this.HOUR; r <=this.SECOND; r++) {
		this.svg.append("circle")
	                          .attr("cx", this.center[0])
	                          .attr("cy", this.center[1])
	                          .attr("fill", "none")
	                          .attr("stroke", "#ddd")
	                          //.attr("stroke-dasharray", "10,5")
	                          .attr("r", this.options.circleRadii[r]);
	}	
	*/

}