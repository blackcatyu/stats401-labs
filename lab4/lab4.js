// STATS 401 - Lab 4
// Loads the airline-level sentiment aggregate (produced by clean_tweets.py)
// and draws a 100%-stacked horizontal bar chart: for each airline, the
// share of tweets RoBERTa scored as negative / neutral / positive.

const width = 760;
const height = 420;

const margin = {
    top: 55,
    right: 150,
    bottom: 45,
    left: 120
};

const categories = ["pct_negative", "pct_neutral", "pct_positive"];
const categoryLabel = {
    pct_negative: "Negative",
    pct_neutral: "Neutral",
    pct_positive: "Positive"
};
// Sentiment is a polarity variable (negative <-> positive around a neutral
// middle), so it's colored as a red/blue diverging pair with a gray
// midpoint rather than red/yellow/green - that avoids putting red and
// green, the pair colorblind readers confuse most, on screen together.
const categoryColor = {
    pct_negative: "#d1495b",
    pct_neutral: "#9a978d",
    pct_positive: "#2a6fb0"
};

d3.csv("../data/lab4_sentiment_by_airline.csv", d => ({
    airline: d.airline,
    n_tweets: +d.n_tweets,
    avg_sentiment: +d.avg_sentiment,
    pct_negative: +d.pct_negative,
    pct_neutral: +d.pct_neutral,
    pct_positive: +d.pct_positive,
    avg_retweets: +d.avg_retweets
})).then(data => {

    data.sort((a, b) => a.avg_sentiment - b.avg_sentiment);

    const svg = d3.select("#chart")
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    const tooltip = d3.select("#tooltip");

    const yScale = d3.scaleBand()
        .domain(data.map(d => d.airline))
        .range([margin.top, height - margin.bottom])
        .padding(0.35);

    const xScale = d3.scaleLinear()
        .domain([0, 1])
        .range([margin.left, width - margin.right]);

    // --- Axes -----------------------------------------------------------
    svg.append("g")
        .attr("transform", `translate(0, ${height - margin.bottom})`)
        .call(d3.axisBottom(xScale).ticks(5).tickFormat(d3.format(".0%")));

    svg.append("g")
        .attr("transform", `translate(${margin.left}, 0)`)
        .call(d3.axisLeft(yScale));

    svg.append("text")
        .attr("x", (margin.left + width - margin.right) / 2)
        .attr("y", height - 8)
        .attr("text-anchor", "middle")
        .text("Share of tweets");

    // --- Stacked bars -----------------------------------------------------
    const rows = svg.selectAll(".airline-row")
        .data(data)
        .join("g")
        .attr("class", "airline-row");

    rows.each(function (d) {
        let x0 = xScale(0);

        d3.select(this)
            .selectAll("rect")
            .data(categories.map(key => ({
                airline: d.airline,
                key,
                value: d[key],
                n_tweets: d.n_tweets
            })))
            .join("rect")
            .attr("y", yScale(d.airline))
            .attr("height", yScale.bandwidth())
            .attr("x", seg => {
                const x = x0;
                x0 += xScale(seg.value) - xScale(0);
                return x;
            })
            .attr("width", seg => Math.max(0, xScale(seg.value) - xScale(0)))
            .attr("fill", seg => categoryColor[seg.key])
            .on("mouseover", (event, seg) => {
                tooltip
                    .style("opacity", 1)
                    .html(
                        `<strong>${seg.airline}</strong><br>` +
                        `${categoryLabel[seg.key]}: ${(seg.value * 100).toFixed(1)}%<br>` +
                        `(${Math.round(seg.value * seg.n_tweets).toLocaleString()} of ${seg.n_tweets.toLocaleString()} scored tweets)`
                    );
            })
            .on("mousemove", event => {
                tooltip
                    .style("left", `${event.pageX + 12}px`)
                    .style("top", `${event.pageY - 20}px`);
            })
            .on("mouseout", () => tooltip.style("opacity", 0));
    });

    // --- Average sentiment score label at the end of each bar -------------
    svg.selectAll(".sentiment-score-label")
        .data(data)
        .join("text")
        .attr("class", "sentiment-score-label")
        .attr("x", width - margin.right + 10)
        .attr("y", d => yScale(d.airline) + yScale.bandwidth() / 2)
        .attr("dy", "0.35em")
        .text(d => `${d.avg_sentiment >= 0 ? "+" : ""}${d.avg_sentiment.toFixed(2)} avg (n=${d.n_tweets})`);

    // --- Legend -------------------------------------------------------------
    const legend = svg.append("g")
        .attr("transform", `translate(${margin.left}, 10)`);

    const legendItems = legend.selectAll(".legend-item")
        .data(categories)
        .join("g")
        .attr("class", "legend-item")
        .attr("transform", (d, i) => `translate(${i * 130}, 0)`);

    legendItems.append("rect")
        .attr("width", 12)
        .attr("height", 12)
        .attr("fill", d => categoryColor[d]);

    legendItems.append("text")
        .attr("x", 18)
        .attr("y", 10)
        .text(d => categoryLabel[d]);
});
