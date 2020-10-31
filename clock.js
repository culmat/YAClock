function YAClock(selector, options) {
    this.options = Object.assign({
		curveType : "curveNatural",
		radii : [50,100,150]
	}, options);
	this.edgeLength = 400;
	this.units = [12,60,60];
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

	this.handle = this.svg
		    .append("path")
	  		.attr("d", d3.line().curve()([
				this.center, 
				this.center
			]))
	  		.attr("stroke", "black")
	  		.attr("fill", "none");

	this.secondCircle = this.svg.append("circle")
	                          .attr("cx", this.center[0])
	                          .attr("cy", this.center[1])
	                          .attr("fill", "none")
	                          .attr("stroke", "black")
	                          .attr("r", 5);

	this.minuteCircle = this.svg.append("circle")
		                          .attr("cx", this.center[0])
		                          .attr("cy", this.center[1])
		                          .attr("fill", "none")
		                          .attr("stroke", "black")
		                          .attr("r", 4);

	this.hourCircle = this.svg.append("circle")
		                          .attr("cx", this.center[0])
		                          .attr("cy", this.center[1])
		                          .attr("fill", "none")
		                          .attr("stroke", "black")
		                          .attr("r", 3);    
		
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
	
	this.dHandle = function () {
		// curveNatural
		// curveStepAfter
		return d3.line().curve(d3[this.options.curveType])([
			this.center, 
			this.hourPoint, 
			this.minutePoint,
			this.secondPoint 
		]);
	};
	
	this.setSeconds = function (seconds){
		this.now.setSeconds(seconds);
		this.secondPoint = this.cPoint(this.units[2], seconds, this.options.radii[2], this.center)
		this.transition(this.secondCircle).attr("cx", this.secondPoint[0])
		                  .attr("cy", this.secondPoint[1]);
	};
	
	this.setMinutes = function (minutes){
		this.now.setMinutes(minutes);
		this.minutePoint = this.cPoint(this.units[1], minutes, this.options.radii[1], this.center)
		this.transition(this.minuteCircle).attr("cx", this.minutePoint[0])
		                  .attr("cy", this.minutePoint[1]);
	};
	
	this.setHours = function (hours){
		this.now.setHours(hours);
		this.hourPoint = this.cPoint(this.units[0], hours, this.options.radii[0], this.center)
		this.transition(this.hourCircle).attr("cx", this.hourPoint[0])
		                  .attr("cy", this.hourPoint[1]);
	};
	
	this.transition = function (it){
		return it.transition().duration(1000);
	};
		
	this.setTime = function (now){	
		this.now = now;
		this.setSeconds(now.getSeconds());
		this.setMinutes(now.getMinutes());
		this.setHours(now.getHours());
		this.transition(this.handle).attr("d", this.dHandle())
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

	
	for (r = 2; r < 3; r++) {
		for (i = 0; i < this.units[r]; i++) {
			var length = i%5 == 0 ? 4:2;
			var p1 = this.cPoint(this.units[r], i, this.options.radii[r]-length, this.center);
			var p2 = this.cPoint(this.units[r], i, this.options.radii[r]+length, this.center);
			this.svg.append("line")
					.attr("x1", p1[0])
	              	.attr("y1", p1[1])
					.attr("x2", p2[0])
	              	.attr("y2", p2[1])
	              	.attr("stroke-width", (r == 0 || i%5 == 0) ? 3:1)
	              	.attr("stroke", "black");
		}
	}

}