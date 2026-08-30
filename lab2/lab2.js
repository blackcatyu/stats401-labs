const width = 800;
const height = 500;

const margin = {
    top: 40,
    right: 170,
    bottom: 70,
    left: 70
};

d3.csv("../data/students_multivariate.csv", d => ({
    name: d.name,
    study_hours: +d.study_hours,
    score: +d.score,
    major: d.major,
    year: d.year
}))
.then(data => {
    console.log(data);
    
    const xScale = d3.scaleLinear()
    .domain(d3.extent(data, d => d.study_hours))
    .nice()
    .range([
        margin.left,
        width - margin.right
    ]);

    const yScale = d3.scaleLinear()
    .domain(d3.extent(data, d => d.score))
    .nice()
    .range([
        height - margin.bottom,
        margin.top
    ]);

    const svg = d3.select("#chart")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

    svg.append("g")
    .attr(
        "transform",
        `translate(0, ${height - margin.bottom})`
    )
    .call(d3.axisBottom(xScale));

    svg.append("g")
    .attr(
        "transform",
        `translate(${margin.left}, 0)`
    )
    .call(d3.axisLeft(yScale));

    svg.append("text")
        .attr("x", width / 2)
        .attr("y", height - 20)
        .attr("text-anchor", "middle")
        .text("Study Hours");

    svg.append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -height / 2)
        .attr("y", 20)
        .attr("text-anchor", "middle")
        .text("Exam Score");

    const majors = Array.from(
        new Set(data.map(d => d.major))
    );

    const colorScale = d3.scaleOrdinal()
        .domain(majors)
        .range(d3.schemeTableau10);

    const sizeScale = d3.scaleOrdinal()
        .domain(["Freshman", "Sophomore", "Junior", "Senior"])
        .range([5, 7, 9, 11]);

    svg.selectAll("circle")
        .data(data)
        .join("circle")
        .attr("cx", d => xScale(d.study_hours))
        .attr("cy", d => yScale(d.score))
        .attr("r", d => sizeScale(d.year))
        .attr("fill", d => colorScale(d.major))
        .on("mouseover", function(event, d) {
            tooltip
                .style("opacity", 1)
                .html(`
                    <strong>${d.name}</strong><br>
                    Study Hours: ${d.study_hours}<br>
                    Score: ${d.score}<br>
                    Major: ${d.major}<br>
                    Year: ${d.year}
                `);
        })
        .on("mousemove", function(event) {
            tooltip
                .style("left", `${event.pageX + 10}px`)
                .style("top", `${event.pageY + 10}px`);
        })
        .on("mouseout", function() {
            tooltip
                .style("opacity", 0);
        });

    const legend = svg.append("g")
    .attr(
        "transform",
        `translate(${width - margin.right + 25}, 60)`
    );

    const legendItems = legend
    .selectAll(".legend-item")
    .data(majors)
    .join("g")
    .attr("class", "legend-item")
    .attr(
        "transform",
        (d, i) => `translate(0, ${i * 28})`
    );

    legendItems.append("circle")
    .attr("r", 6)
    .attr("fill", d => colorScale(d));

    legendItems.append("text")
    .attr("x", 12)
    .attr("y", 4)
    .text(d => d);

    const tooltip = d3.select("#tooltip");
});


d3.csv("../data/cities_multivariate.csv", d => ({
    city: d.city,
    population: +d.population,
    temp_c: +d.temp_c,
    development_level: d.development_level,
    region: d.region
}))
.then(cities => {
    console.log(cities);

    const W = 760;
    const H = 480;
    const m = { top: 40, right: 150, bottom: 60, left: 90 };

    const svg = d3.select("#chart-assignment")
        .append("svg")
        .attr("width", W)
        .attr("height", H);

    const tooltip = d3.select("#tooltip");

    const x = d3.scaleLinear()
        .domain(d3.extent(cities, d => d.temp_c))
        .nice()
        .range([m.left, W - m.right]);

    const y = d3.scalePoint()
        .domain(["Low", "Medium", "High"])
        .range([H - m.bottom, m.top])
        .padding(0.5);

    const size = d3.scaleSqrt()
        .domain(d3.extent(cities, d => d.population))
        .range([6, 24]);

    const regions = Array.from(new Set(cities.map(d => d.region)));

    const color = d3.scaleOrdinal()
        .domain(regions)
        .range(d3.schemeTableau10);

    
    svg.append("g")
        .attr("transform", `translate(0, ${H - m.bottom})`)
        .call(d3.axisBottom(x));

    
    svg.append("g")
        .attr("transform", `translate(${m.left}, 0)`)
        .call(d3.axisLeft(y));

    
    svg.append("text")
        .attr("x", W / 2).attr("y", H - 15)
        .attr("text-anchor", "middle")
        .text("Average Temperature (°C)");

    svg.append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -H / 2).attr("y", 25)
        .attr("text-anchor", "middle")
        .text("Development Level");

    svg.selectAll(".city-bubble")
        .data(cities)
        .join("circle")
        .attr("class", "city-bubble")
        .attr("cx", d => x(d.temp_c))
        .attr("cy", d => y(d.development_level))
        .attr("r", d => size(d.population))
        .attr("fill", d => color(d.region))
        .attr("stroke", "#333")
        .attr("stroke-width", 0.6)
        .attr("opacity", 0.8)
        .on("mouseover", function(event, d) {
            tooltip
                .style("opacity", 1)
                .html(`
                    <strong>${d.city}</strong><br>
                    Population: ${d.population} M<br>
                    Temp: ${d.temp_c} °C<br>
                    Development: ${d.development_level}<br>
                    Region: ${d.region}
                `);
        })
        .on("mousemove", function(event) {
            tooltip
                .style("left", `${event.pageX + 10}px`)
                .style("top", `${event.pageY + 10}px`);
        })
        .on("mouseout", function() {
            tooltip.style("opacity", 0);
        });

    const legend = svg.append("g")
        .attr("transform", `translate(${W - m.right + 30}, ${m.top + 10})`);

    const items = legend.selectAll(".lg-item")
        .data(regions)
        .join("g")
        .attr("class", "lg-item")
        .attr("transform", (d, i) => `translate(0, ${i * 26})`);

    items.append("circle")
        .attr("r", 7)
        .attr("fill", d => color(d));

    items.append("text")
        .attr("x", 14)
        .attr("y", 4)
        .text(d => d);

    legend.append("text")
        .attr("x", 0).attr("y", -14)
        .attr("font-weight", "bold")
        .text("Region");
});