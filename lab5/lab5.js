// STATS 401 - Lab 5: Interactive Network Visualization
// Part A: force-directed node-link diagram of a 50-station transit network
// Part B: adjacency matrix of the same network
//
// Node variables : district (color), daily_passengers (radius),
//                  station_type (stroke style)
// Link variables : travel_time_min (width + matrix opacity),
//                  route_type (color)

const DISTRICTS = ["Central", "North", "South", "East", "West"];
const districtColor = d3.scaleOrdinal()
    .domain(DISTRICTS)
    .range(["#4E79A7", "#59A14F", "#B07AA1", "#EDC948", "#FF9DA7"]);

const ROUTE_TYPES = ["Metro", "Express", "Shuttle"];
const routeColor = d3.scaleOrdinal()
    .domain(ROUTE_TYPES)
    .range(["#499894", "#E15759", "#79706E"]);

Promise.all([
    d3.csv("../data/lab5_assignment_stations.csv"),
    d3.csv("../data/lab5_assignment_routes.csv")
]).then(([stationRows, routeRows]) => {

    // --- Parse -------------------------------------------------------------
    const nodes = stationRows.map(d => ({
        id: d.id,
        name: d.station_name,
        district: d.district,
        passengers: +d.daily_passengers,
        type: d.station_type
    }));

    const links = routeRows.map(d => ({
        source: d.source,
        target: d.target,
        time: +d.travel_time_min,
        route: d.route_type
    }));

    // Degree (used for node inspection and one matrix ordering).
    const degree = new Map(nodes.map(n => [n.id, 0]));
    const neighbors = new Map(nodes.map(n => [n.id, new Set()]));
    links.forEach(l => {
        degree.set(l.source, degree.get(l.source) + 1);
        degree.set(l.target, degree.get(l.target) + 1);
        neighbors.get(l.source).add(l.target);
        neighbors.get(l.target).add(l.source);
    });
    nodes.forEach(n => { n.degree = degree.get(n.id); });

    // --- Shared scales ---------------------------------------------------
    const radius = d3.scaleSqrt()
        .domain(d3.extent(nodes, n => n.passengers))
        .range([4, 16]);

    const linkWidth = d3.scaleLinear()
        .domain(d3.extent(links, l => l.time))
        .range([1, 5]);

    buildNetwork(nodes, links, { radius, linkWidth, neighbors });
    buildMatrix(nodes, links);
    buildLegends({ radius, linkWidth });
});


// =====================================================================
// PART A - Force-directed node-link diagram
// =====================================================================

function buildNetwork(nodes, links, { radius, linkWidth, neighbors }) {
    const width = 900;
    const height = 720;
    const shelfY = height - 46;   // where the unconnected stations park

    const svg = d3.select("#network")
        .append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", "100%")
        .attr("height", height);

    // The 5 degree-0 stations carry no relational position, so they are
    // pinned to a labelled shelf along the bottom instead of being flung to
    // the corners by the charge force.
    const isolated = nodes.filter(n => n.degree === 0);
    isolated.forEach((n, i) => {
        n.isolated = true;
        n.shelfX = 70 + (i + 0.5) / isolated.length * (width - 140);
        n.fx = n.shelfX;
        n.fy = shelfY;
    });

    if (isolated.length) {
        svg.append("text")
            .attr("x", 12).attr("y", shelfY - 26)
            .attr("font-size", 12).attr("fill", "#898781")
            .text("Unconnected stations");
    }

    // Seed connected stations on a ring in ID order so the main chain starts
    // "unrolled" - the simulation then relaxes it without knotting as badly.
    const connected = nodes.filter(n => !n.isolated);
    connected.forEach((n, i) => {
        const a = (i / connected.length) * 2 * Math.PI;
        n.x = width / 2 + Math.cos(a) * 250;
        n.y = (height / 2 - 24) + Math.sin(a) * 210;
    });

    const tooltip = d3.select("#net-tooltip");

    // Strong repulsion + generous link distance spreads the 40-edge main
    // chain into a loose backbone instead of a knot. Isolated stations are
    // pinned, so they are excluded from charge to keep them from pushing the
    // cluster around.
    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id)
            .distance(d => 55 + d.time * 7).strength(0.35))
        .force("charge", d3.forceManyBody().strength(d => d.isolated ? 0 : -750))
        .force("center", d3.forceCenter(width / 2, height / 2 - 24))
        .force("collide", d3.forceCollide().radius(d => radius(d.passengers) + 7))
        .force("x", d3.forceX(width / 2).strength(0.025))
        .force("y", d3.forceY(height / 2 - 24).strength(0.025))
        .alphaDecay(0.017);

    // --- Links ---------------------------------------------------------
    const link = svg.append("g")
        .attr("fill", "none")
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke", d => routeColor(d.route))
        .attr("stroke-width", d => linkWidth(d.time))
        .attr("stroke-linecap", "round")
        .attr("stroke-opacity", 0.75)
        .on("mousemove", (event, d) => {
            showTip(tooltip, event,
                `<strong>${nodeName(d.source)} &harr; ${nodeName(d.target)}</strong><br>` +
                `${d.time} min &middot; ${d.route}`);
        })
        .on("mouseout", () => hideTip(tooltip));

    // --- Nodes (a <g> per station: outer transfer ring + main circle) ---
    const node = svg.append("g")
        .selectAll("g")
        .data(nodes)
        .join("g")
        .attr("class", "net-node")
        .call(drag(simulation))
        .on("mouseover", (event, d) => highlight(d))
        .on("mousemove", (event, d) => {
            showTip(tooltip, event,
                `<strong>${d.name}</strong><br>` +
                `${d.district} district &middot; ${d.type}<br>` +
                `${d.passengers.toLocaleString()} daily passengers<br>` +
                `${d.degree} connection${d.degree === 1 ? "" : "s"}`);
        })
        .on("mouseout", () => { hideTip(tooltip); unhighlight(); });

    // Transfer stations get a concentric ring (interchange convention).
    node.filter(d => d.type === "Transfer")
        .append("circle")
        .attr("r", d => radius(d.passengers) + 3.5)
        .attr("fill", "none")
        .attr("stroke", "#222")
        .attr("stroke-width", 1.4);

    node.append("circle")
        .attr("r", d => radius(d.passengers))
        .attr("fill", d => districtColor(d.district))
        .attr("stroke", d => d.type === "Local" ? "#666" : "#222")
        .attr("stroke-width", d => d.type === "Terminal" ? 3 : 1.4);

    simulation.on("tick", () => {
        // Keep everything (including the 5 isolated stations) inside the frame.
        nodes.forEach(d => {
            const r = radius(d.passengers) + 5;
            d.x = Math.max(r, Math.min(width - r, d.x));
            d.y = Math.max(r, Math.min(height - r, d.y));
        });

        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    // --- Hover highlighting: focus a node, its links, and its neighbors ---
    function highlight(d) {
        const keep = neighbors.get(d.id);
        node.style("opacity", n => (n.id === d.id || keep.has(n.id)) ? 1 : 0.12);
        link
            .style("opacity", l =>
                (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.06)
            .attr("stroke-width", l =>
                (l.source.id === d.id || l.target.id === d.id)
                    ? linkWidth(l.time) + 1.5
                    : linkWidth(l.time));
    }

    function unhighlight() {
        node.style("opacity", 1);
        link.style("opacity", null).attr("stroke-width", l => linkWidth(l.time));
    }

    function nodeName(endpoint) {
        return typeof endpoint === "object" ? endpoint.name : endpoint;
    }

    function drag(sim) {
        return d3.drag()
            .on("start", (event, d) => {
                if (!event.active) sim.alphaTarget(0.3).restart();
                d.fx = d.x; d.fy = d.y;
            })
            .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
            .on("end", (event, d) => {
                if (!event.active) sim.alphaTarget(0);
                // Unconnected stations snap back to their shelf.
                d.fx = d.isolated ? d.shelfX : null;
                d.fy = d.isolated ? shelfY : null;
            });
    }
}


// =====================================================================
// PART B - Adjacency matrix
// =====================================================================

function buildMatrix(nodes, links) {
    const n = nodes.length;
    const cell = 11;
    const grid = n * cell;
    const margin = { top: 96, left: 96, right: 20, bottom: 20 };
    const width = margin.left + grid + margin.right;
    const height = margin.top + grid + margin.bottom;

    const svg = d3.select("#matrix")
        .append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", "100%")
        .attr("height", height);

    const g = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const tooltip = d3.select("#matrix-tooltip");

    // Edge lookup, symmetric. buildNetwork's d3.forceLink() mutates each
    // link's source/target from an id string into a node object, so accept
    // either form here.
    const endId = v => (typeof v === "object" ? v.id : v);
    const edge = new Map();
    links.forEach(l => {
        edge.set(`${endId(l.source)}|${endId(l.target)}`, l);
        edge.set(`${endId(l.target)}|${endId(l.source)}`, l);
    });

    const timeOpacity = d3.scaleLinear()
        .domain(d3.extent(links, l => l.time))
        .range([0.4, 1]);

    const orderings = {
        district: [...nodes].sort((a, b) =>
            d3.ascending(DISTRICTS.indexOf(a.district), DISTRICTS.indexOf(b.district))
            || d3.ascending(+a.id.slice(1), +b.id.slice(1))),
        degree: [...nodes].sort((a, b) =>
            d3.descending(a.degree, b.degree) || d3.ascending(+a.id.slice(1), +b.id.slice(1))),
        id: [...nodes].sort((a, b) => d3.ascending(+a.id.slice(1), +b.id.slice(1)))
    };

    let order = orderings.district;

    // District color strips along the top and left edges.
    const topStrip = g.append("g");
    const leftStrip = g.append("g");

    // Background grid.
    g.append("g").attr("class", "matrix-grid").selectAll("line.v")
        .data(d3.range(n + 1)).join("line")
        .attr("y1", 0).attr("y2", grid)
        .attr("x1", d => d * cell).attr("x2", d => d * cell)
        .attr("stroke", "#e6e6e6");
    g.append("g").attr("class", "matrix-grid").selectAll("line.h")
        .data(d3.range(n + 1)).join("line")
        .attr("x1", 0).attr("x2", grid)
        .attr("y1", d => d * cell).attr("y2", d => d * cell)
        .attr("stroke", "#e6e6e6");

    const cellsLayer = g.append("g");
    const rowLabelsLayer = g.append("g").attr("class", "matrix-label");
    const colLabelsLayer = g.append("g").attr("class", "matrix-label");
    const dividersLayer = g.append("g");
    const crosshair = g.append("g").attr("pointer-events", "none");

    const hRule = crosshair.append("rect")
        .attr("x", 0).attr("width", grid).attr("height", cell)
        .attr("fill", "#000").attr("opacity", 0).style("mix-blend-mode", "multiply");
    const vRule = crosshair.append("rect")
        .attr("y", 0).attr("height", grid).attr("width", cell)
        .attr("fill", "#000").attr("opacity", 0).style("mix-blend-mode", "multiply");

    render();

    d3.selectAll("input[name='matrix-order']").on("change", function () {
        order = orderings[this.value];
        render();
    });

    function render() {
        // Cells - one rect per connected (row, col) pair, both triangles.
        const cellData = [];
        order.forEach((rowNode, i) => {
            order.forEach((colNode, j) => {
                if (i === j) return;
                const l = edge.get(`${rowNode.id}|${colNode.id}`);
                if (l) cellData.push({ i, j, link: l, rowNode, colNode });
            });
        });

        cellsLayer.selectAll("rect")
            .data(cellData, d => `${d.rowNode.id}-${d.colNode.id}`)
            .join("rect")
            .attr("x", d => d.j * cell + 1)
            .attr("y", d => d.i * cell + 1)
            .attr("width", cell - 2)
            .attr("height", cell - 2)
            .style("fill", d => routeColor(d.link.route))
            .style("opacity", d => timeOpacity(d.link.time))
            .on("mousemove", (event, d) => {
                showTip(tooltip, event,
                    `<strong>${d.rowNode.name} &harr; ${d.colNode.name}</strong><br>` +
                    `${d.link.time} min &middot; ${d.link.route}`);
                hRule.attr("y", d.i * cell).attr("opacity", 0.08);
                vRule.attr("x", d.j * cell).attr("opacity", 0.08);
            })
            .on("mouseout", () => {
                hideTip(tooltip);
                hRule.attr("opacity", 0);
                vRule.attr("opacity", 0);
            });

        // Row / column labels (station numbers).
        rowLabelsLayer.selectAll("text")
            .data(order, d => d.id)
            .join("text")
            .attr("x", -6)
            .attr("y", (d, i) => i * cell + cell / 2)
            .attr("dy", "0.32em")
            .attr("text-anchor", "end")
            .text(d => d.id.slice(1));

        colLabelsLayer.selectAll("text")
            .data(order, d => d.id)
            .join("text")
            .attr("transform", (d, i) => `translate(${i * cell + cell / 2}, -6) rotate(-90)`)
            .attr("dy", "0.32em")
            .attr("text-anchor", "start")
            .text(d => d.id.slice(1));

        // District color strips (fill via .style so the global
        // `svg rect:hover` rule in style.css can't recolour them).
        topStrip.selectAll("rect").data(order, d => d.id).join("rect")
            .attr("x", (d, i) => i * cell).attr("y", -14)
            .attr("width", cell).attr("height", 9)
            .style("fill", d => districtColor(d.district));
        leftStrip.selectAll("rect").data(order, d => d.id).join("rect")
            .attr("x", -14).attr("y", (d, i) => i * cell)
            .attr("width", 9).attr("height", cell)
            .style("fill", d => districtColor(d.district));

        // District block dividers - only meaningful in the district ordering.
        const boundaries = [];
        if (order === orderings.district) {
            for (let i = 1; i < order.length; i++) {
                if (order[i].district !== order[i - 1].district) boundaries.push(i);
            }
        }
        dividersLayer.selectAll("line.dv").data(boundaries).join("line")
            .attr("class", "dv")
            .attr("x1", d => d * cell).attr("x2", d => d * cell)
            .attr("y1", -14).attr("y2", grid)
            .attr("stroke", "#333").attr("stroke-width", 1);
        dividersLayer.selectAll("line.dh").data(boundaries).join(
            enter => enter.append("line").attr("class", "dh"),
            update => update,
            exit => exit.remove()
        )
            .attr("y1", d => d * cell).attr("y2", d => d * cell)
            .attr("x1", -14).attr("x2", grid)
            .attr("stroke", "#333").attr("stroke-width", 1);
    }
}


// =====================================================================
// Legends
// =====================================================================

function buildLegends({ radius, linkWidth }) {
    // District swatches
    const dl = d3.select("#legend-district");
    DISTRICTS.forEach(d => {
        const item = dl.append("span").attr("class", "legend-chip");
        item.append("span").attr("class", "swatch").style("background", districtColor(d));
        item.append("span").text(d);
    });

    // Route type - colored line samples
    const rl = d3.select("#legend-route");
    ROUTE_TYPES.forEach(r => {
        const item = rl.append("span").attr("class", "legend-chip");
        item.append("span").attr("class", "line-swatch").style("background", routeColor(r));
        item.append("span").text(r);
    });

    // Station type - glyphs
    const sl = d3.select("#legend-type");
    const typeSvg = sl.append("svg").attr("width", 260).attr("height", 34);
    const specs = [
        { label: "Local", cx: 12, r: 8, stroke: "#666", sw: 1.4, ring: false },
        { label: "Terminal", cx: 92, r: 8, stroke: "#222", sw: 3, ring: false },
        { label: "Transfer", cx: 182, r: 8, stroke: "#222", sw: 1.4, ring: true }
    ];
    specs.forEach(s => {
        if (s.ring) {
            typeSvg.append("circle").attr("cx", s.cx).attr("cy", 17).attr("r", s.r + 3.5)
                .attr("fill", "none").attr("stroke", "#222").attr("stroke-width", 1.4);
        }
        typeSvg.append("circle").attr("cx", s.cx).attr("cy", 17).attr("r", s.r)
            .attr("fill", "#ccc").attr("stroke", s.stroke).attr("stroke-width", s.sw);
        typeSvg.append("text").attr("x", s.cx + 16).attr("y", 21).text(s.label)
            .attr("font-size", 12).attr("fill", "#333");
    });

    // Node size - passenger volume
    const nz = d3.select("#legend-size").append("svg").attr("width", 320).attr("height", 52);
    const sizeStops = [1373, 5525, 9850];
    let x = 24;
    sizeStops.forEach(v => {
        nz.append("circle").attr("cx", x).attr("cy", 26).attr("r", radius(v))
            .attr("fill", "#ccc").attr("stroke", "#666");
        nz.append("text").attr("x", x).attr("y", 48).attr("text-anchor", "middle")
            .attr("font-size", 11).attr("fill", "#333").text(v.toLocaleString());
        x += 90;
    });

    // Link width - travel time
    const lw = d3.select("#legend-width").append("svg").attr("width", 320).attr("height", 52);
    const timeStops = [2, 9, 16];
    x = 20;
    timeStops.forEach(v => {
        lw.append("line").attr("x1", x).attr("x2", x + 46).attr("y1", 22).attr("y2", 22)
            .attr("stroke", "#79706E").attr("stroke-width", linkWidth(v)).attr("stroke-linecap", "round");
        lw.append("text").attr("x", x + 23).attr("y", 44).attr("text-anchor", "middle")
            .attr("font-size", 11).attr("fill", "#333").text(`${v} min`);
        x += 100;
    });
}


// =====================================================================
// Tooltip helpers
// =====================================================================

function showTip(tip, event, html) {
    tip.html(html)
        .style("opacity", 1)
        .style("left", `${event.pageX + 14}px`)
        .style("top", `${event.pageY - 12}px`);
}

function hideTip(tip) {
    tip.style("opacity", 0);
}
