d3.csv("../data/students.csv", d => ({
    name: d.name,
    score: +d.score
})).then(data => {
    const width = 640;
    const height = 460;
    const barWidth = 50;
    const gap = 26;
    const baseline = 380;      

    const svg = d3.select("#chart")
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    
    const y = d3.scaleLinear()
        .domain([60, 100])
        .range([0, 320]);

    
    const color = d3.scaleLinear()
        .domain([60, 100])
        .range(["#a5c8e1", "#1f4e79"]);

    
    const barX = (d, i) => i * (barWidth + gap) + 30;
    const centerX = (d, i) => barX(d, i) + barWidth / 2;

    
    svg.selectAll("rect")
        .data(data)
        .join("rect")
        .attr("x", barX)
        .attr("y", d => baseline - y(d.score))
        .attr("width", barWidth)
        .attr("height", d => y(d.score))
        .attr("rx", 6)                     // 圆角柱顶
        .attr("fill", d => color(d.score));

    
    svg.selectAll(".score-top")
        .data(data)
        .join("text")
        .attr("class", "score-top")
        .attr("x", centerX)
        .attr("y", d => baseline - y(d.score) - 8)
        .attr("text-anchor", "middle")
        .text(d => d.score);

    
    svg.selectAll(".name-label")
        .data(data)
        .join("text")
        .attr("class", "name-label")
        .attr("x", centerX)
        .attr("y", baseline + 22)
        .attr("text-anchor", "middle")
        .text(d => d.name);


});