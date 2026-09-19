// STATS 401 - Lab 7 Assignment: Temporal Commercial Network
//
// 12 companies, 60 days of transactions. Each frame filters the transactions
// to the current time window, aggregates them into one undirected link per
// company pair, and feeds those links to a d3.forceSimulation().
//
// Node : size   = transaction value in the current window (calculateVolume)
//        colour = sector, shape = region
// Link : width  = total amount traded, colour = dominant transaction type,
//        dashed = links two different regions
//
// Mental map : the same 12 node objects live for the whole animation, the
// layout is pre-settled on the full 60-day network, each node is gently pulled
// back towards its pre-settled "home" position, and every update only re-heats
// the simulation a little (RESTART_ALPHA).

const WIDTH = 900;
const HEIGHT = 560;
const TOTAL_DAYS = 60;
const FRAME_MS = 800;

const parseDate = d3.timeParse("%Y-%m-%d");
const formatDate = d3.timeFormat("%b %d, %Y");
const formatShort = d3.timeFormat("%b %d");
const formatMoney = d3.format("$,.0f");
const formatMoneyShort = d3.format("$.2s");

const NEUTRAL_LINK_COLOR = "#8c8c8c"; // legend samples only
const RESTART_ALPHA = 0.3;
const ANCHOR_STRENGTH = 0.2;
const NEW_LINK_EXTRA_WIDTH = 6;

const REGIONS = ["Asia", "Europe", "North America"];
const regionSymbol = d3.scaleOrdinal()
    .domain(REGIONS)
    .range([d3.symbolCircle, d3.symbolSquare, d3.symbolTriangle]);

const tooltip = d3.select("#tooltip");

Promise.all([
    d3.csv("../data/lab7_assignment_companies.csv"),
    d3.csv("../data/lab7_assignment_transactions_60days.csv", d => ({
        date: parseDate(d.date),
        day: +d.day,
        source: d.source,
        target: d.target,
        amount_usd: +d.amount_usd,
        transaction_type: d.transaction_type,
        transaction_count: +d.transaction_count,
    })),
]).then(([companies, transactions]) => init(companies, transactions));


// Total value of the links touching one company (links hold company ids here).
function calculateVolume(companyId, currentLinks) {
    return d3.sum(
        currentLinks.filter(d => d.source === companyId || d.target === companyId),
        d => d.amount_usd
    );
}

function pairKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
}


function init(companies, transactions) {
    const sectors = Array.from(new Set(companies.map(d => d.sector))).sort();
    const sectorColor = d3.scaleOrdinal()
        .domain(sectors)
        .range(d3.schemeTableau10);

    const regionOf = new Map(companies.map(d => [d.id, d.region]));
    const nameOf = new Map(companies.map(d => [d.id, d.company_name]));
    const dateByDay = new Map(transactions.map(d => [d.day, d.date]));

    const types = Array.from(new Set(transactions.map(d => d.transaction_type))).sort();
    const typeColor = d3.scaleOrdinal()
        .domain(types)
        .range(d3.schemeDark2);

    const radius = d3.scaleSqrt().range([7, 30]);
    const widthScale = d3.scaleSqrt().range([2.5, 11]);

    let windowSize = 7;
    let day = 1;
    let frames = [];
    let timer = null;

    // --- Frames: everything derived from the data, computed once per window --
    function buildFrame(d) {
        const rows = transactions.filter(t => t.day > d - windowSize && t.day <= d);

        const links = Array.from(
            d3.group(rows, t => pairKey(t.source, t.target)),
            ([key, v]) => {
                const [a, b] = key.split("-");
                return {
                    key,
                    source: a,
                    target: b,
                    amount_usd: d3.sum(v, t => t.amount_usd),
                    transaction_count: d3.sum(v, t => t.transaction_count),
                    transactions: v.length,
                    types: d3.rollups(v, g => d3.sum(g, t => t.amount_usd),
                        t => t.transaction_type).sort((x, y) => y[1] - x[1]),
                    cross: regionOf.get(a) !== regionOf.get(b),
                    firstDay: d3.min(v, t => t.day),
                    lastDay: d3.max(v, t => t.day),
                };
            }
        );

        const volume = new Map(companies.map(c => [c.id, calculateVolume(c.id, links)]));
        const degree = d3.rollup(links.flatMap(l => [l.source, l.target]),
            v => v.length, id => id);

        return {
            day: d,
            date: dateByDay.get(d),
            links,
            volume,
            degree,
            totalValue: d3.sum(links, l => l.amount_usd),
            activeCompanies: new Set(links.flatMap(l => [l.source, l.target])).size,
            crossShare: links.length ? d3.mean(links, l => (l.cross ? 1 : 0)) : 0,
        };
    }

    function rebuildFrames() {
        frames = d3.range(1, TOTAL_DAYS + 1).map(buildFrame);
        // Fixed scales across the whole animation so sizes and widths are comparable over time.
        radius.domain([0, d3.max(frames, f => d3.max(f.volume.values()))]);
        widthScale.domain([0, d3.max(frames, f => d3.max(f.links, l => l.amount_usd))]);
    }

    // --- SVG --------------------------------------------------------------
    const svg = d3.select("#network")
        .append("svg")
        .attr("viewBox", [0, 0, WIDTH, HEIGHT])
        .attr("width", "100%")
        .attr("height", HEIGHT);

    const linkLayer = svg.append("g").attr("class", "link-layer");
    const nodeLayer = svg.append("g").attr("class", "node-layer");

    // --- Persistent nodes and the force simulation ---------------------------
    const nodes = companies.map((c, i) => {
        const angle = (2 * Math.PI * i) / companies.length;
        return {
            ...c,
            volume: 0,
            degree: 0,
            r: radius.range()[0],
            x: WIDTH / 2 + 180 * Math.cos(angle),
            y: HEIGHT / 2 + 180 * Math.sin(angle),
        };
    });

    const linkForce = d3.forceLink().id(d => d.id).distance(150).strength(0.3);

    const simulation = d3.forceSimulation(nodes)
        .force("link", linkForce)
        .force("charge", d3.forceManyBody().strength(-800))
        .force("x", d3.forceX(WIDTH / 2).strength(0.04))
        .force("y", d3.forceY(HEIGHT / 2).strength(0.04))
        .force("collide", d3.forceCollide().radius(d => d.r + 14))
        .on("tick", ticked);

    // Pre-settle on the union of all 60 days so the first frame already has a
    // sensible layout that later frames only nudge.
    function presettle() {
        const allPairs = Array.from(
            d3.group(transactions, t => pairKey(t.source, t.target)).keys(),
            key => {
                const [source, target] = key.split("-");
                return { source, target };
            }
        );
        simulation.stop();
        linkForce.links(allPairs);
        for (let i = 0; i < 300; i++) simulation.tick();

        // Remember the settled layout and pull every node gently back towards it,
        // so the picture keeps the same overall shape from day to day.
        nodes.forEach(n => {
            n.ax = n.x;
            n.ay = n.y;
        });
        simulation
            .force("x", d3.forceX(d => d.ax).strength(ANCHOR_STRENGTH))
            .force("y", d3.forceY(d => d.ay).strength(ANCHOR_STRENGTH));
    }

    const nodeSel = nodeLayer.selectAll(".net-node")
        .data(nodes, d => d.id)
        .join("g")
        .attr("class", "net-node")
        .call(d3.drag()
            .on("start", (event, d) => {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", (event, d) => {
                d.fx = event.x;
                d.fy = event.y;
            })
            .on("end", (event, d) => {
                if (!event.active) simulation.alphaTarget(0);
                d.fx = null;
                d.fy = null;
            }))
        .on("mouseover", (event, d) => {
            tooltip.style("opacity", 1).html(`
                <strong>${d.company_name}</strong><br>
                Sector: ${d.sector}<br>
                Region: ${d.region}<br>
                Volume in window: ${formatMoney(d.volume)}<br>
                Active links: ${d.degree}
            `);
        })
        .on("mousemove", moveTooltip)
        .on("mouseout", hideTooltip);

    nodeSel.append("path")
        .attr("fill", d => sectorColor(d.sector))
        .attr("stroke", "#333")
        .attr("stroke-width", 1.2)
        .attr("d", d => symbolPath(d));

    nodeSel.append("text")
        .attr("class", "net-label")
        .attr("text-anchor", "middle")
        .text(d => d.company_name);

    function symbolPath(d) {
        return d3.symbol()
            .type(regionSymbol(d.region))
            .size(Math.PI * d.r * d.r)();
    }

    function ticked() {
        nodes.forEach(d => {
            d.x = Math.max(d.r + 6, Math.min(WIDTH - d.r - 6, d.x));
            d.y = Math.max(d.r + 6, Math.min(HEIGHT - d.r - 22, d.y));
        });

        linkLayer.selectAll("line")
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
    }

    // --- Update the picture for one day ----------------------------------------
    function update(frame) {
        // Fresh link objects each frame: forceLink replaces source/target ids with node objects.
        const links = frame.links.map(d => ({ ...d }));

        nodes.forEach(n => {
            n.volume = frame.volume.get(n.id);
            n.degree = frame.degree.get(n.id) || 0;
            n.r = radius(n.volume);
        });

        const t = d3.transition().duration(500);

        nodeSel.select("path")
            .transition(t)
            .attr("d", d => symbolPath(d));

        nodeSel.transition(t)
            .style("opacity", d => (d.degree > 0 ? 1 : 0.35));

        nodeSel.select("text")
            .transition(t)
            .attr("y", d => d.r + 13);

        linkLayer.selectAll("line")
            .data(links, d => d.key)
            .join(
                // A new link appears extra thick, then shrinks to its real width.
                enter => enter.append("line")
                    .attr("stroke-linecap", "round")
                    .attr("stroke-width", d => widthScale(d.amount_usd) + NEW_LINK_EXTRA_WIDTH)
                    .attr("opacity", 0)
                    .call(e => e.transition(t).attr("opacity", 0.85))
                    .call(e => e.transition("grow").delay(600).duration(1200)
                        .attr("stroke-width", d => widthScale(d.amount_usd))),
                update => update
                    .interrupt()
                    .attr("pointer-events", null)
                    .call(u => u.transition(t)
                        .attr("opacity", 0.85)
                        .attr("stroke-width", d => widthScale(d.amount_usd))),
                exit => exit
                    .attr("pointer-events", "none")
                    .call(x => x.transition(t).attr("opacity", 0).remove())
            )
            .attr("stroke", d => typeColor(d.types[0][0]))
            .attr("stroke-dasharray", d => (d.cross ? "7 5" : null))
            .on("mouseover", (event, d) => {
                const typeList = d.types
                    .map(([type, amount]) => `${type} (${formatMoney(amount)})`)
                    .join(", ");
                tooltip.style("opacity", 1).html(`
                    <strong>${nameOf.get(d.source.id ?? d.source)} &harr;
                    ${nameOf.get(d.target.id ?? d.target)}</strong><br>
                    ${regionOf.get(d.source.id ?? d.source)} &ndash;
                    ${regionOf.get(d.target.id ?? d.target)}
                    (${d.cross ? "cross-region" : "same region"})<br>
                    Total: ${formatMoney(d.amount_usd)}<br>
                    Transaction records: ${d.transactions}<br>
                    Transaction count: ${d.transaction_count}<br>
                    Types: ${typeList}<br>
                    Active on days ${d.firstDay}&ndash;${d.lastDay}
                `);
            })
            .on("mousemove", moveTooltip)
            .on("mouseout", hideTooltip);

        linkForce.links(links);
        simulation.nodes(nodes);
        simulation.alpha(RESTART_ALPHA).restart();
    }

    function moveTooltip(event) {
        tooltip
            .style("left", `${event.pageX + 12}px`)
            .style("top", `${event.pageY + 12}px`);
    }

    function hideTooltip() {
        tooltip.style("opacity", 0);
    }

    // --- Time control ----------------------------------------------------------
    const slider = d3.select("#day-slider");
    const playBtn = d3.select("#btn-play");
    const pauseBtn = d3.select("#btn-pause");

    function setDay(d) {
        day = d;
        const frame = frames[day - 1];

        slider.property("value", day);

        const startDay = Math.max(1, day - windowSize + 1);
        const range = startDay < day
            ? `${formatShort(dateByDay.get(startDay))} &ndash; ${formatDate(frame.date)}`
            : formatDate(frame.date);
        d3.select("#day-label").html(
            `<strong>Day ${day} of ${TOTAL_DAYS}</strong> &middot; ${range}` +
            ` <span class="hint">(${windowSize}-day link window)</span>`
        );

        d3.select("#stat-links").text(frame.links.length);
        d3.select("#stat-companies").text(frame.activeCompanies);
        d3.select("#stat-value").text(formatMoney(frame.totalValue));
        d3.select("#stat-cross").text(d3.format(".0%")(frame.crossShare));

        update(frame);
    }

    function setPlaying(on) {
        playBtn.property("disabled", on);
        pauseBtn.property("disabled", !on);
    }

    function pause() {
        if (timer) timer.stop();
        timer = null;
        setPlaying(false);
    }

    function play() {
        if (timer) return;
        if (day >= TOTAL_DAYS) setDay(1);
        setPlaying(true);
        timer = d3.interval(() => {
            if (day >= TOTAL_DAYS) {
                pause();
                return;
            }
            setDay(day + 1);
        }, FRAME_MS);
    }

    playBtn.on("click", play);
    pauseBtn.on("click", pause);
    d3.select("#btn-reset").on("click", () => {
        pause();
        setDay(1);
    });
    slider.on("input", event => {
        pause();
        setDay(+event.target.value);
    });
    d3.select("#window-select").on("change", event => {
        windowSize = +event.target.value;
        rebuildFrames();
        buildSizeLegend();
        buildWidthLegend();
        setDay(day);
    });

    // --- Legends ---------------------------------------------------------------
    function buildStaticLegends() {
        d3.select("#sector-legend").selectAll(".legend-chip")
            .data(sectors)
            .join("span")
            .attr("class", "legend-chip")
            .html(d => `<span class="swatch" style="background:${sectorColor(d)}"></span>${d}`);

        d3.select("#region-legend").selectAll(".legend-chip")
            .data(REGIONS)
            .join("span")
            .attr("class", "legend-chip")
            .html(d => {
                const path = d3.symbol().type(regionSymbol(d)).size(130)();
                return `<svg width="16" height="16" viewBox="-8 -8 16 16">
                    <path d="${path}" fill="#bbb" stroke="#333"></path></svg>${d}`;
            });

        d3.select("#type-legend").selectAll(".legend-chip")
            .data(types)
            .join("span")
            .attr("class", "legend-chip")
            .html(d => `<span class="line-swatch" style="background:${typeColor(d)}"></span>${d}`);

        d3.select("#style-legend").selectAll(".legend-chip")
            .data([
                { label: "Same region", dash: null },
                { label: "Cross-region", dash: "7 5" },
            ])
            .join("span")
            .attr("class", "legend-chip")
            .html(d => `<svg width="30" height="8" viewBox="0 0 30 8">
                <line x1="1" y1="4" x2="29" y2="4" stroke="${NEUTRAL_LINK_COLOR}"
                      stroke-width="3" stroke-linecap="round"
                      ${d.dash ? `stroke-dasharray="${d.dash}"` : ""}></line></svg>${d.label}`);
    }

    function buildSizeLegend() {
        const max = radius.domain()[1];
        const samples = [0, max / 2, max];
        d3.select("#size-legend").selectAll(".legend-chip")
            .data(samples)
            .join("span")
            .attr("class", "legend-chip")
            .html(d => {
                const r = radius(d);
                return `<svg width="${2 * r + 2}" height="${2 * r + 2}">
                    <circle cx="${r + 1}" cy="${r + 1}" r="${r}"
                            fill="#ddd" stroke="#333"></circle></svg>
                    ${d === 0 ? "$0" : formatMoneyShort(d)}`;
            });
    }

    function buildWidthLegend() {
        const max = widthScale.domain()[1];
        const samples = [max / 4, max / 2, max];
        d3.select("#width-legend").selectAll(".legend-chip")
            .data(samples)
            .join("span")
            .attr("class", "legend-chip")
            .html(d => `<svg width="30" height="14" viewBox="0 0 30 14">
                <line x1="1" y1="7" x2="29" y2="7" stroke="${NEUTRAL_LINK_COLOR}"
                      stroke-width="${widthScale(d)}" stroke-linecap="round"></line></svg>
                ${formatMoneyShort(d)}`);
    }

    // --- Start -----------------------------------------------------------------
    rebuildFrames();
    buildStaticLegends();
    buildSizeLegend();
    buildWidthLegend();
    presettle();
    setPlaying(false);
    setDay(1);
}
