// Lab 9 — 2025 GDP: choropleth vs. Dorling cartogram
// Both maps share one projection and one selection state.

const W = 960;
const H = 470;
const R_MAX = 78;                     // circle radius for the largest economy (px)
const NO_DATA_FILL = "url(#nodata-hatch)";

const fmtComma = d3.format(",.0f");
const fmtGDP = b => b >= 1000
    ? `$${(b / 1000).toFixed(2)} trillion`
    : `$${fmtComma(b)} billion`;
const fmtShort = b => b >= 1000
    ? `$${d3.format(".3~")(b / 1000)}T`
    : `$${fmtComma(b)}B`;
const fmtPct = d3.format(".1%");

const tooltip = d3.select("#tooltip");

Promise.all([
    d3.json("../data/lab9_world.geojson"),
    d3.csv("../data/lab9_gdp_2025_top50.csv", d => ({
        iso3: d.iso3,
        country: d.country,
        gdp: +d.gdp_2025_billion_usd,
        rank: +d.rank
    }))
]).then(([world, stats]) => {

    // ------------------------------------------------------------------
    // Part A: join GDP onto the GeoJSON by ISO-3
    // ------------------------------------------------------------------
    const statById = new Map(stats.map(d => [d.iso3, d]));
    const total = d3.sum(stats, d => d.gdp);

    world.features.forEach(f => {
        const s = statById.get(f.properties.iso3);
        f.properties.gdp = s ? s.gdp : null;          // null = no data, never 0
        f.properties.rank = s ? s.rank : null;
        f.properties.country = s ? s.country : f.properties.name;
    });

    const geoIds = new Set(world.features.map(f => f.properties.iso3));
    const unmatched = stats.filter(d => !geoIds.has(d.iso3));
    const nMatched = stats.length - unmatched.length;
    console.log("Lab 9 join:", nMatched, "matched; unmatched:", unmatched);

    d3.select("#join-check").html(
        `<strong>Join check:</strong> ${nMatched} of ${stats.length} economies matched a boundary. ` +
        (unmatched.length
            ? `Unmatched: ${unmatched.map(d => d.iso3).join(", ")}.`
            : `The other ${world.features.length - nMatched} boundaries have no GDP value in the dataset.`)
    );

    // ------------------------------------------------------------------
    // Shared projection
    // ------------------------------------------------------------------
    const projection = d3.geoEqualEarth()
        .fitExtent([[6, 6], [W - 6, H - 6]], world);
    const path = d3.geoPath(projection);

    // Anchor = centroid of a country's largest polygon, so France is not
    // pulled toward French Guiana or the U.S. toward Alaska and Hawaii.
    function mainPolygon(f) {
        const g = f.geometry;
        if (g.type === "Polygon") return g;
        return d3.greatest(
            g.coordinates.map(c => ({ type: "Polygon", coordinates: c })),
            p => d3.geoArea(p)
        );
    }
    world.features.forEach(f => {
        f.properties.anchor = projection(d3.geoCentroid(mainPolygon(f)));
        f.properties.pxArea = path.area(f);
    });

    const dataFeatures = world.features.filter(f => f.properties.gdp != null);

    // ------------------------------------------------------------------
    // Shared selection state (Part D)
    // ------------------------------------------------------------------
    let hovered = null;
    let pinned = null;
    const views = [];                 // each view registers an update(activeId) function

    function active() { return hovered || pinned; }

    function refresh() {
        const id = active();
        views.forEach(update => update(id));

        const s = statById.get(pinned);
        d3.select("#selection-readout").text(
            s ? `${s.country}: rank ${s.rank}, ${fmtGDP(s.gdp)}` : ""
        );
        d3.select("#country-select").property("value", pinned || "");
    }

    function setHover(id) { hovered = id; refresh(); }
    function togglePin(id) { pinned = pinned === id ? null : id; refresh(); }
    function clearPin() { pinned = null; refresh(); }

    function showTooltip(event, id, name) {
        const s = statById.get(id);
        tooltip
            .style("opacity", 1)
            .html(s
                ? `<strong>${s.country}</strong><br>` +
                  `2025 GDP: ${fmtGDP(s.gdp)}<br>` +
                  `Rank ${s.rank} of 50, ${fmtPct(s.gdp / total)} of top-50 total`
                : `<strong>${name}</strong><br>No data (not in the top-50 dataset)`);
        moveTooltip(event);
    }

    function moveTooltip(event) {
        // keyboard focus events have no pointer position: place near the element
        let x = event.pageX, y = event.pageY;
        if (x === undefined || (x === 0 && y === 0)) {
            const box = event.target.getBoundingClientRect();
            x = box.left + window.scrollX + box.width / 2;
            y = box.top + window.scrollY + box.height / 2;
        }
        const tw = tooltip.node().offsetWidth;
        const flip = x + 12 + tw > window.scrollX + document.documentElement.clientWidth - 8;
        tooltip
            .style("left", `${flip ? x - 12 - tw : x + 12}px`)
            .style("top", `${y + 12}px`);
    }

    function hideTooltip() { tooltip.style("opacity", 0); }

    // Attach hover / click / keyboard behaviour to country marks in either map
    function bindInteraction(selection, idOf, nameOf) {
        selection
            .on("mouseover", (event, d) => { setHover(idOf(d)); showTooltip(event, idOf(d), nameOf(d)); })
            .on("mousemove", moveTooltip)
            .on("mouseout", () => { setHover(null); hideTooltip(); })
            .on("click", (event, d) => { event.stopPropagation(); togglePin(idOf(d)); })
            .on("focus", (event, d) => { setHover(idOf(d)); showTooltip(event, idOf(d), nameOf(d)); })
            .on("blur", () => { setHover(null); hideTooltip(); })
            .on("keydown", (event, d) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    togglePin(idOf(d));
                }
            });
    }

    // Build an SVG with ocean, a zoomable group and a reset button
    function makeMap(containerId, label, resetId) {
        const svg = d3.select(containerId)
            .append("svg")
            .attr("viewBox", `0 0 ${W} ${H}`)
            .attr("role", "img")
            .attr("aria-label", label);

        const zoomLayer = svg.append("g");

        zoomLayer.append("path")
            .datum({ type: "Sphere" })
            .attr("class", "ocean")
            .attr("d", path)
            .on("click", clearPin);

        const zoom = d3.zoom()
            .scaleExtent([1, 8])
            .translateExtent([[0, 0], [W, H]])
            .on("zoom", event => {
                zoomLayer.attr("transform", event.transform);
            });
        svg.call(zoom).on("dblclick.zoom", null);

        d3.select(resetId).on("click", () =>
            svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity));

        return { svg, zoomLayer };
    }

    // ------------------------------------------------------------------
    // Part B: choropleth
    // ------------------------------------------------------------------
    const colorDomain = [300, 31000];
    const color = d3.scaleSequentialLog()
        .domain(colorDomain)
        .interpolator(t => d3.interpolateYlGnBu(0.12 + 0.88 * t))
        .clamp(true);

    const choro = makeMap("#choropleth",
        "World choropleth of 2025 nominal GDP for the 50 largest economies", "#reset-choropleth");

    const hatch = choro.svg.append("defs")
        .append("pattern")
        .attr("id", "nodata-hatch")
        .attr("patternUnits", "userSpaceOnUse")
        .attr("width", 5)
        .attr("height", 5)
        .attr("patternTransform", "rotate(45)");
    hatch.append("rect").attr("width", 5).attr("height", 5).attr("fill", "#f4f3f1");
    hatch.append("line")
        .attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 5)
        .attr("stroke", "#cbc8c3").attr("stroke-width", 1.5);

    const countries = choro.zoomLayer.append("g")
        .selectAll("path")
        .data(world.features)
        .join("path")
        .attr("class", d => "country " + (d.properties.gdp == null ? "no-data" : "has-data"))
        .attr("d", path)
        .attr("fill", d => d.properties.gdp == null ? NO_DATA_FILL : color(d.properties.gdp));

    countries.filter(".has-data")
        .attr("tabindex", 0)
        .attr("aria-label", d => `${d.properties.country}, ${fmtGDP(d.properties.gdp)}`);

    bindInteraction(countries, d => d.properties.iso3, d => d.properties.country);

    // Locator ring for countries too small to see (Singapore, Hong Kong, ...)
    const locator = choro.zoomLayer.append("circle")
        .attr("class", "locator")
        .attr("r", 9)
        .style("display", "none");

    views.push(id => {
        countries
            .classed("is-active", d => d.properties.iso3 === id)
            .classed("is-dimmed", d => id != null && d.properties.iso3 !== id);
        countries.filter(".is-active").raise();

        const f = dataFeatures.find(d => d.properties.iso3 === id);
        if (f && f.properties.pxArea < 40) {
            locator.attr("cx", f.properties.anchor[0]).attr("cy", f.properties.anchor[1])
                .style("display", null).raise();
        } else {
            locator.style("display", "none");
        }
    });

    // Colour legend (log scale) + no-data swatch
    const legendW = 240;
    const legendX = 24;
    const legendY = H - 58;
    const lg = choro.svg.append("g")
        .attr("class", "map-legend")
        .attr("transform", `translate(${legendX},${legendY})`);

    const grad = choro.svg.select("defs").append("linearGradient").attr("id", "gdp-gradient");
    d3.range(0, 1.0001, 0.1).forEach(t => {
        grad.append("stop")
            .attr("offset", `${t * 100}%`)
            .attr("stop-color", color(colorDomain[0] * Math.pow(colorDomain[1] / colorDomain[0], t)));
    });

    lg.append("text").attr("class", "legend-heading").attr("y", -8)
        .text("2025 GDP, US$ (log scale)");
    lg.append("rect").attr("width", legendW).attr("height", 12).attr("fill", "url(#gdp-gradient)");

    const lx = d3.scaleLog().domain(colorDomain).range([0, legendW]);
    lg.append("g")
        .attr("class", "legend-axis")
        .attr("transform", "translate(0,12)")
        .call(d3.axisBottom(lx).tickValues([300, 1000, 3000, 10000, 30000]).tickFormat(fmtShort).tickSize(4));

    const nd = lg.append("g").attr("transform", `translate(${legendW + 26},0)`);
    nd.append("rect").attr("width", 18).attr("height", 12).attr("fill", NO_DATA_FILL).attr("stroke", "#cbc8c3");
    nd.append("text").attr("class", "legend-text").attr("x", 24).attr("y", 10).text("No data");

    // ------------------------------------------------------------------
    // Part C: Dorling cartogram
    // ------------------------------------------------------------------
    const radius = d3.scaleSqrt()
        .domain([0, d3.max(stats, d => d.gdp)])
        .range([0, R_MAX]);

    const nodes = dataFeatures.map(f => ({
        id: f.properties.iso3,
        country: f.properties.country,
        gdp: f.properties.gdp,
        x0: f.properties.anchor[0],
        y0: f.properties.anchor[1],
        x: f.properties.anchor[0],
        y: f.properties.anchor[1],
        r: radius(f.properties.gdp)
    }));

    // Pull each circle toward its country, push overlapping circles apart.
    // Run to completion before drawing so the layout is static.
    const sim = d3.forceSimulation(nodes)
        .force("x", d3.forceX(d => d.x0).strength(0.18))
        .force("y", d3.forceY(d => d.y0).strength(0.18))
        .force("collide", d3.forceCollide(d => d.r + 1.5).iterations(4))
        .stop();
    for (let i = 0; i < 400; i++) {
        sim.tick();
        nodes.forEach(d => {
            d.x = Math.max(d.r + 2, Math.min(W - d.r - 2, d.x));
            d.y = Math.max(d.r + 2, Math.min(H - d.r - 2, d.y));
        });
    }

    const carto = makeMap("#cartogram",
        "Dorling cartogram of 2025 nominal GDP: circle area is proportional to GDP", "#reset-cartogram");

    const ghosts = carto.zoomLayer.append("g")
        .attr("class", "ghost-layer")
        .selectAll("path")
        .data(world.features)
        .join("path")
        .attr("class", "ghost")
        .attr("d", path);

    d3.select("#toggle-outlines").on("change", function () {
        carto.zoomLayer.select(".ghost-layer").style("display", this.checked ? null : "none");
    });

    const bubbles = carto.zoomLayer.append("g")
        .selectAll("g")
        .data(nodes.sort((a, b) => b.r - a.r))
        .join("g")
        .attr("class", "bubble")
        .attr("transform", d => `translate(${d.x},${d.y})`)
        .attr("tabindex", 0)
        .attr("aria-label", d => `${d.country}, ${fmtGDP(d.gdp)}`);

    bubbles.append("circle").attr("r", d => d.r);

    // Label: full name when it fits, ISO-3 code otherwise, nothing for the smallest
    bubbles.each(function (d) {
        const g = d3.select(this);
        const size = Math.min(12, Math.max(7.5, d.r * 0.55));
        const fitsName = d.country.length * size * 0.56 < 2 * d.r - 10;
        const text = fitsName ? d.country : (d.r >= 9 ? d.id : "");
        if (!text) return;
        const t = g.append("text")
            .attr("class", "bubble-label")
            .style("font-size", `${size}px`);
        if (d.r >= 40) {
            t.append("tspan").attr("x", 0).attr("dy", "-0.2em").text(text);
            t.append("tspan").attr("x", 0).attr("dy", "1.2em").attr("class", "bubble-value").text(fmtShort(d.gdp));
        } else {
            t.attr("dy", "0.35em").text(text);
        }
    });

    bindInteraction(bubbles, d => d.id, d => d.country);

    views.push(id => {
        bubbles
            .classed("is-active", d => d.id === id)
            .classed("is-dimmed", d => id != null && d.id !== id);
        bubbles.filter(".is-active").raise();
        ghosts.classed("is-active", d => d.properties.iso3 === id);
    });

    // Area legend: nested circles
    const al = carto.svg.append("g")
        .attr("class", "map-legend")
        .attr("transform", `translate(${24 + radius(20000)},${H - 14})`);
    al.append("text").attr("class", "legend-heading")
        .attr("x", -radius(20000)).attr("y", -2 * radius(20000) - 10)
        .text("Circle area = 2025 GDP");
    [20000, 5000, 1000].forEach(v => {
        const r = radius(v);
        al.append("circle").attr("class", "legend-circle").attr("cy", -r).attr("r", r);
        al.append("line").attr("class", "legend-leader")
            .attr("x1", 0).attr("x2", radius(20000) + 12)
            .attr("y1", -2 * r).attr("y2", -2 * r);
        al.append("text").attr("class", "legend-text")
            .attr("x", radius(20000) + 16).attr("y", -2 * r).attr("dy", "0.35em")
            .text(fmtShort(v));
    });

    // ------------------------------------------------------------------
    // Shared controls
    // ------------------------------------------------------------------
    d3.select("#country-select")
        .selectAll("option.econ")
        .data(stats.slice().sort((a, b) => a.rank - b.rank))
        .join("option")
        .attr("class", "econ")
        .attr("value", d => d.iso3)
        .text(d => `${d.rank}. ${d.country}`);

    d3.select("#country-select").on("change", function () {
        pinned = this.value || null;
        refresh();
    });
    d3.select("#clear-selection").on("click", clearPin);

    refresh();

}).catch(err => {
    console.error(err);
    d3.select("#join-check").text(
        "The map data could not be loaded. Serve the site over HTTP (for example with Live Server) " +
        "rather than opening the file directly."
    );
});