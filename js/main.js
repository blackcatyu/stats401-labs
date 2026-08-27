let course = "STATS 401";
let students = 40;

console.log(course);
console.log(students);
console.log("Hello STATS 401!");
console.log("D3 version:", d3.version);

d3.select("#title")
    .text("Student Score Visualization");

d3.select("#title")
    .style("color", "steelblue")
    .style("font-size", "28px");

d3.select("#content")
    .append("p")
    .text("This paragraph was created using D3.");


const content = d3.select("#content");

content.append("h3")
    .text("My Dataset");

content.append("p")
    .text("The dataset contains student scores.");


const data = [10, 20, 30, 40, 50];

d3.select("#numbers")
    .selectAll("p")
    .data(data)
    .join("p")
    .text(d => `Value: ${d}`);


const values = [10, 20, 30, 40, 50];

const svg = d3.select("#svg-demo")
    .append("svg")
    .attr("width", 600)
    .attr("height", 200);
svg.selectAll("circle")
    .data(values)
    .join("circle")
    .attr("cx", (d, i) => 60 + i * 100)
    .attr("cy", 100)
    .attr("r", d => d / 2)
    .attr("fill", "steelblue");


d3.csv("data/students.csv")
    .then(data => {
        data.forEach(d => {
            d.score = Number (d.score);
        });
        console.log(data);
        console.log(typeof data[0].score);  // 现在应该是 "number" 了
    });


d3.json("data/students.json")
    .then(data => {

        console.log(data);

    });