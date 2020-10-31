function YAClock(selector) {

	this.edgeLength = 400;
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
		                          .attr("r", 6);

	this.hourCircle = this.svg.append("circle")
		                          .attr("cx", this.center[0])
		                          .attr("cy", this.center[1])
		                          .attr("fill", "none")
		                          .attr("stroke", "black")
		                          .attr("r", 7);    
		
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
		return d3.line().curve(d3.curveNatural)([
			this.center, 
			this.hourPoint, 
			this.minutePoint,
			this.secondPoint 
		]);
	};
	
	this.setSeconds = function (seconds){
		this.now.setSeconds(seconds);
		this.secondPoint = this.cPoint(60, seconds, 150, this.center)
		this.secondCircle .attr("cx", this.secondPoint[0])
		                  .attr("cy", this.secondPoint[1]);
	};
	
	this.setMinutes = function (minutes){
		this.now.setMinutes(minutes);
		this.minutePoint = this.cPoint(60, minutes, 100, this.center)
		this.minuteCircle .attr("cx", this.minutePoint[0])
		                  .attr("cy", this.minutePoint[1]);
	};
	
	this.setHours = function (hours){
		this.now.setHours(hours);
		this.hourPoint = this.cPoint(24, hours, 50, this.center)
		this.hourCircle .attr("cx", this.hourPoint[0])
		                  .attr("cy", this.hourPoint[1]);
	};
	
	this.setTime = function (now){	
		this.now = now;
		this.setSeconds(now.getSeconds());
		this.setMinutes(now.getMinutes());
		this.setHours(now.getHours());
		this.handle.attr("d", this.dHandle())
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

}