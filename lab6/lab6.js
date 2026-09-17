// STATS 401 - Lab 6 Assignment: GDP Hierarchy Treemaps
//
// World -> continent -> area -> country, built from lab6_assignment_gdp.csv
// by convert_hierarchy.py. Two zoomable treemaps render the same hierarchy
// with different tiling methods.
//
// Overview       : one cell per continent, sized by total GDP, colored by
//                  continent identity. Click a continent to zoom in.
// Continent view : that continent's area/country hierarchy fills the whole
//                  canvas - country rectangle area = gdp_billion_usd,
//                  country rectangle color = gdp_status. Areas are shown as
//                  bordered, labelled bands behind the country rectangles.
//
// Zooming in this way (rather than always drawing all four levels at once)
// is what keeps small continents such as Africa or Oceania readable: once
// zoomed, their countries are laid out against the full canvas instead of
// being squeezed into a sliver next to the US or China.

const STATUSES = ["Increase", "Unchanged", "Decrease"];
const statusColor = d3.scaleOrdinal()
    .domain(STATUSES)
    .range(["#59A14F", "#B7B2A7", "#E15759"]);

const tooltip = d3.select("#tooltip");

d3.json("../data/lab6_assignment_gdp.json").then(data => {
    buildTreemap({
        container: "#treemap-squarify",
        crumb: "#crumb-squarify",
        data,
        tile: d3.treemapSquarify,
    });

    buildTreemap({
        container: "#treemap-binary",
        crumb: "#crumb-binary",
        data,
        tile: d3.treemapBinary,
    });

    buildLegend();
});


function buildTreemap({ container, crumb, data, tile }) {
    const width = 900;
    const height = 560;
    const duration = 650;

    const root = d3.hierarchy(data)
        .sum(d => d.gdp || 0)
        .sort((a, b) => b.value - a.value);

    d3.treemap()
        .tile(tile)
        .size([width, height])
        .paddingOuter(3)
        .paddingTop(d => (d.depth === 2 ? 16 : 0))
        .paddingInner(1)
        .round(true)
        (root);

    const continentColor = d3.scaleOrdinal()
        .domain(root.children.map(d => d.data.name))
        .range(d3.schemeSet2);

    const svg = d3.select(container)
        .append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", "100%")
        .attr("height", height);

    const x = d3.scaleLinear().domain([0, width]).range([0, width]);
    const y = d3.scaleLinear().domain([0, height]).range([0, height]);

    const crumbSel = d3.select(crumb);
    let focus = root;

    // --- Overview layer: one cell per continent -----------------------------
    const continentSel = svg.selectAll(".continent")
        .data(root.children)
        .join("g")
        .attr("class", "continent")
        .attr("transform", d => `translate(${d.x0},${d.y0})`)
        .style("cursor", "pointer")
        .on("click", (event, d) => zoomIn(d));

    continentSel.append("rect")
        .attr("class", "continent-rect")
        .attr("width", d => d.x1 - d.x0)
        .attr("height", d => d.y1 - d.y0)
        .attr("fill", d => continentColor(d.data.name));

    continentSel.append("text")
        .attr("class", "continent-label")
        .attr("x", 8)
        .attr("y", 22)
        .text(d => d.data.name);

    continentSel.append("text")
        .attr("class", "continent-sublabel")
        .attr("x", 8)
        .attr("y", 40)
        .text(d => `$${d.value.toLocaleString()}B GDP`);

    // --- Continent-focus layer: area bands + country leaves -----------------
    const areaSel = svg.selectAll(".area-group")
        .data(root.descendants().filter(d => d.depth === 2))
        .join("g")
        .attr("class", "area-group")
        .style("opacity", 0)
        .style("pointer-events", "none");

    areaSel.append("rect").attr("class", "group-rect");
    areaSel.append("text")
        .attr("class", "group-label")
        .attr("x", 4)
        .attr("y", 12);

    const leafSel = svg.selectAll(".leaf")
        .data(root.leaves())
        .join("g")
        .attr("class", "leaf")
        .style("opacity", 0)
        .style("pointer-events", "none")
        .on("mouseover", function(event, d) {
            const area = d.parent;
            const continent = area.parent;
            tooltip
                .style("opacity", 1)
                .html(`
                    <strong>${d.data.name}</strong><br>
                    ${continent.data.name} &rsaquo; ${area.data.name}<br>
                    GDP: $${d.value.toLocaleString()} billion<br>
                    Status: ${d.data.status}
                `);
        })
        .on("mousemove", event => {
            tooltip
                .style("left", `${event.pageX + 12}px`)
                .style("top", `${event.pageY + 12}px`);
        })
        .on("mouseout", () => tooltip.style("opacity", 0));

    leafSel.append("rect").attr("fill", d => statusColor(d.data.status));
    leafSel.append("text")
        .attr("class", "leaf-label")
        .attr("x", 4)
        .attr("y", 13);

    function isAncestorOrSelf(node, target) {
        for (let p = node; p; p = p.parent) {
            if (p === target) return true;
        }
        return false;
    }

    function positionCell(sel) {
        sel.attr("transform", d => `translate(${x(d.x0)},${y(d.y0)})`)
            .call(g => g.select("rect")
                .attr("width", d => Math.max(0, x(d.x1) - x(d.x0)))
                .attr("height", d => Math.max(0, y(d.y1) - y(d.y0))));
    }

    function refreshLabels(sel, selector, minW, minH) {
        sel.select(selector).each(function(d) {
            const w = x(d.x1) - x(d.x0);
            const h = y(d.y1) - y(d.y0);
            const fits = w >= minW && (minH === undefined || h >= minH)
                && this.getComputedTextLength() <= w - 6;
            d3.select(this).style("opacity", fits ? 1 : 0);
        });
    }

    function renderCrumb() {
        if (focus === root) {
            crumbSel.html('<span class="hint">Click a continent to zoom into its countries.</span>');
        } else {
            crumbSel.html(
                `<a href="#" class="crumb-back">&larr; All continents</a>` +
                ` <strong>${focus.data.name}</strong>`
            );
            crumbSel.select(".crumb-back").on("click", event => {
                event.preventDefault();
                zoomOut();
            });
        }
    }

    function zoomIn(continent) {
        focus = continent;
        x.domain([continent.x0, continent.x1]);
        y.domain([continent.y0, continent.y1]);

        const visibleAreas = areaSel.filter(d => isAncestorOrSelf(d, continent));
        const visibleLeaves = leafSel.filter(d => isAncestorOrSelf(d, continent));

        continentSel.style("pointer-events", "none");
        visibleAreas.style("pointer-events", "auto");
        visibleLeaves.style("pointer-events", "auto");

        // Hide labels immediately; they're re-measured once the transition ends.
        visibleAreas.select(".group-label").style("opacity", 0);
        visibleLeaves.select(".leaf-label").style("opacity", 0);

        visibleAreas.select(".group-label").text(d => d.data.name);
        visibleLeaves.select(".leaf-label").text(d => d.data.name);

        const t = svg.transition().duration(duration);

        positionCell(continentSel.transition(t));
        continentSel.transition(t).style("opacity", 0);

        positionCell(visibleAreas.transition(t));
        visibleAreas.transition(t).style("opacity", 1);

        positionCell(visibleLeaves.transition(t));
        visibleLeaves.transition(t).style("opacity", 1);

        t.end()
            .then(() => {
                refreshLabels(visibleAreas, ".group-label", 30, 16);
                refreshLabels(visibleLeaves, ".leaf-label", 34, 16);
            })
            .catch(() => {}); // interrupted by a rapid re-click; the next zoom call settles it

        renderCrumb();
    }

    function zoomOut() {
        focus = root;
        x.domain([0, width]);
        y.domain([0, height]);

        continentSel.style("pointer-events", "auto");
        areaSel.style("pointer-events", "none");
        leafSel.style("pointer-events", "none");

        const t = svg.transition().duration(duration);

        positionCell(continentSel.transition(t));
        continentSel.transition(t).style("opacity", 1);

        positionCell(areaSel.transition(t));
        areaSel.transition(t).style("opacity", 0);

        positionCell(leafSel.transition(t));
        leafSel.transition(t).style("opacity", 0);

        renderCrumb();
    }

    renderCrumb();
}


function buildLegend() {
    const legend = d3.select("#status-legend");

    legend.selectAll(".legend-chip")
        .data(STATUSES)
        .join("span")
        .attr("class", "legend-chip")
        .html(d => `<span class="swatch" style="background:${statusColor(d)}"></span>${d}`);
}
