// STATS 401 - Lab 8 Assignment: Exploring the DKU Undergraduate Bulletin
//
// Two coordinated views over the same 575 passages:
//   View 1 : semantic embedding map (UMAP of MiniLM embeddings)
//            position = semantic similarity, colour = topic, area = length
//   View 2 : Topic x Section matrix (rows = formal structure in document order,
//            columns = topics, shade = share of the row's passages)
//
// One shared `state` drives both views and the detail panel. Every control
// (search, section / topic filters, matrix cell, row label, column header,
// map point) only edits `state` and calls update(); update() re-renders the
// map opacity, the matrix counts / outlines and the panel from scratch.

const MAP_W = 860;
const MAP_H = 640;
const DIM_OPACITY = 0.07;

// Column order groups related topics: study rules, student life, majors.
const TOPIC_ORDER = [2, 8, 7, 1, 4, 5, 9, 6, 3, 0];
const TOPIC_COLORS = {
    2: "#2a78d6", 8: "#eb6834", 7: "#1baf7a", 1: "#e34948", 4: "#e87ba4",
    5: "#eda100", 9: "#4a3aa7", 6: "#008300", 3: "#6b7b8c", 0: "#9c6b30",
};
const TOPIC_SHORT = {
    2: "Grading & Standing",
    8: "Credit Transfer & Study Away",
    7: "Leave, Withdrawal & Fees",
    1: "Integrity & Grievances",
    4: "Advising & Support",
    5: "Campus Life & Identity",
    9: "Major Overviews",
    6: "STEM Courses",
    3: "Hum./Soc. Major Courses",
    0: "Hum./Soc. Electives",
};

const MATRIX_SHADE = d3.scaleSequential(d3.interpolateRgb("#e3eefb", "#104281"))
    .domain([0, 1]);
const EMPTY_CELL = "#f4f3ef";

const fmtPct = d3.format(".0%");
const tooltip = d3.select("#tooltip");

const state = {
    query: "",
    section: "all",     // "all" | "ch:<chapter_short>" | "sec:<matrix_section>"
    topic: "all",       // "all" | cluster id as a string
    cell: null,         // {level, row, topic}
    selected: null,     // passage_id
    level: "chapter",   // matrix granularity
};

Promise.all([
    d3.csv("../data/lab8_embedding_map.csv", d => ({
        ...d,
        x: +d.x,
        y: +d.y,
        page: +d.page,
        word_count: +d.word_count,
        cluster: +d.cluster,
        chapter_num: +d.chapter_num,
        section_typicality: +d.section_typicality,
        neighbors: d.neighbors.split("|"),
        neighbor_sims: d.neighbor_sims.split("|").map(Number),
    })),
    d3.csv("../data/lab8_topic_section_matrix.csv", d => ({
        ...d,
        row_order: +d.row_order,
        count: +d.count,
        row_total: +d.row_total,
        row_entropy: +d.row_entropy,
    })),
    d3.csv("../data/lab8_topics.csv", d => ({ ...d, cluster: +d.cluster, n: +d.n })),
    d3.csv("../data/lab8_top_terms.csv", d => ({ ...d, mean_tfidf: +d.mean_tfidf, doc_freq: +d.doc_freq })),
    d3.json("../data/lab8_corpus_stats.json"),
]).then(([passages, matrix, topics, terms, stats]) => {
    init(passages, matrix, topics, terms, stats);
});


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function rowKey(d, level) {
    return level === "chapter" ? d.chapter_short : d.matrix_section;
}

function showTooltip(event, html) {
    tooltip.html(html)
        .style("left", `${event.pageX + 14}px`)
        .style("top", `${event.pageY - 10}px`)
        .style("opacity", 1);
}

function hideTooltip() {
    tooltip.style("opacity", 0);
}

// Search + section filter + topic filter (+ matrix cell unless ignored).
function passes(d, { ignoreCell = false } = {}) {
    if (state.query && !d.text.toLowerCase().includes(state.query)) return false;
    if (state.section !== "all") {
        const cut = state.section.indexOf(":");
        const [kind, value] = [state.section.slice(0, cut), state.section.slice(cut + 1)];
        if (kind === "ch" && d.chapter_short !== value) return false;
        if (kind === "sec" && d.matrix_section !== value) return false;
    }
    if (state.topic !== "all" && d.cluster !== +state.topic) return false;
    if (!ignoreCell && state.cell) {
        if (rowKey(d, state.cell.level) !== state.cell.row || d.cluster !== state.cell.topic) return false;
    }
    return true;
}

function topicChip(cluster, name) {
    return `<span class="topic-chip"><span class="swatch" style="background:${TOPIC_COLORS[cluster]}"></span>${escapeHtml(name)}</span>`;
}

function wrapLines(text, maxChars) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
        if (line && (line + " " + w).length > maxChars) {
            lines.push(line);
            line = w;
        } else {
            line = line ? line + " " + w : w;
        }
    }
    if (line) lines.push(line);
    return lines;
}


// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(passages, matrix, topics, terms, stats) {
    const byId = new Map(passages.map(d => [d.passage_id, d]));
    const topicName = new Map(topics.map(t => [t.cluster, t.cluster_name]));

    drawStats(stats);
    drawChapterChart(passages);
    drawTermChart(terms);

    const map = drawSemanticMap(passages, byId, topicName);
    const mat = drawMatrix(passages, matrix, topicName);
    buildControls(passages, topicName);

    function update() {
        map.update();
        mat.update();
        renderPanel(passages, byId, topicName, topics);
        const n = passages.filter(d => passes(d)).length;
        const active = state.query || state.section !== "all" || state.topic !== "all" || state.cell;
        d3.select("#match-count").text(active ? `${n} of ${passages.length} passages match` : "");
    }

    // expose so every view can trigger a re-render
    window.lab8Update = update;
    update();
}

function refresh() {
    window.lab8Update();
}


// ---------------------------------------------------------------------------
// 1. Corpus stats and overview charts
// ---------------------------------------------------------------------------

function drawStats(stats) {
    const boxes = [
        [stats.raw, "Raw passages extracted"],
        [stats.after_near_dup, `After cleaning (−${stats.raw - stats.after_short} short, −${stats.after_short - stats.after_exact_dup} duplicate, −${stats.after_exact_dup - stats.after_near_dup} near-duplicate)`],
        [stats.mean_words, `Mean words per passage (median ${stats.median_words})`],
        [stats.n_chapters, "Chapters (Parts 1–10)"],
        [stats.n_sections, `Formal sections (${stats.n_subsections} subsections)`],
        [stats.n_table_passages, "Course-table passages"],
    ];
    d3.select("#corpus-stats")
        .selectAll(".summary-box")
        .data(boxes)
        .join("div")
        .attr("class", "summary-box")
        .html(([v, name]) => `<span class="summary-value">${v}</span><span class="summary-name">${name}</span>`);
}

function drawChapterChart(passages) {
    const rows = d3.rollups(passages, v => ({ n: v.length, mean: d3.mean(v, d => d.word_count) }),
        d => d.chapter_num, d => d.chapter_short)
        .map(([num, inner]) => ({ num, name: inner[0][0], ...inner[0][1] }))
        .sort((a, b) => a.num - b.num);

    const labelW = 200, panelW = 170, gap = 36, rowH = 24, top = 26;
    const width = labelW + panelW * 2 + gap + 30;
    const height = top + rows.length * rowH + 10;

    const svg = d3.select("#chart-chapters").append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("width", width)
        .attr("height", height)
        .attr("class", "overview-svg");

    const y = d3.scaleBand().domain(rows.map(d => d.name)).range([top, height - 10]).padding(0.25);
    const panels = [
        { key: "n", title: "Passages", x0: labelW, fmt: d3.format("d") },
        { key: "mean", title: "Mean words", x0: labelW + panelW + gap, fmt: d3.format(".0f") },
    ];

    svg.append("g").selectAll("text")
        .data(rows)
        .join("text")
        .attr("class", "axis-label")
        .attr("x", labelW - 8)
        .attr("y", d => y(d.name) + y.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .text(d => d.name);

    for (const p of panels) {
        const x = d3.scaleLinear().domain([0, d3.max(rows, d => d[p.key])]).range([0, panelW - 34]);
        const g = svg.append("g").attr("transform", `translate(${p.x0},0)`);
        g.append("text").attr("class", "panel-title").attr("x", 0).attr("y", 14).text(p.title);
        g.append("line").attr("class", "baseline").attr("x1", 0).attr("x2", 0)
            .attr("y1", top - 4).attr("y2", height - 10);
        g.selectAll("rect")
            .data(rows)
            .join("rect")
            .attr("class", "bar")
            .attr("x", 0)
            .attr("y", d => y(d.name))
            .attr("height", y.bandwidth())
            .attr("width", d => Math.max(1, x(d[p.key])))
            .attr("rx", 3)
            .on("mousemove", (event, d) => showTooltip(event,
                `<strong>${escapeHtml(d.name)}</strong><br>${d.n} passages<br>mean ${d.mean.toFixed(1)} words`))
            .on("mouseleave", hideTooltip);
        g.selectAll(".bar-value")
            .data(rows)
            .join("text")
            .attr("class", "bar-value")
            .attr("x", d => x(d[p.key]) + 4)
            .attr("y", d => y(d.name) + y.bandwidth() / 2)
            .attr("dy", "0.35em")
            .text(d => p.fmt(d[p.key]));
    }
}

function drawTermChart(terms) {
    const rows = terms.slice(0, 20);
    const labelW = 110, barW = 330, rowH = 16, top = 8;
    const width = labelW + barW + 50;
    const height = top + rows.length * rowH + 22;

    const svg = d3.select("#chart-terms").append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("width", width)
        .attr("height", height)
        .attr("class", "overview-svg");

    const y = d3.scaleBand().domain(rows.map(d => d.term)).range([top, height - 22]).padding(0.22);
    const x = d3.scaleLinear().domain([0, d3.max(rows, d => d.mean_tfidf)]).range([0, barW]);

    svg.append("g").selectAll("text")
        .data(rows)
        .join("text")
        .attr("class", "axis-label")
        .attr("x", labelW - 8)
        .attr("y", d => y(d.term) + y.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .text(d => d.term);

    const g = svg.append("g").attr("transform", `translate(${labelW},0)`);
    g.selectAll("rect")
        .data(rows)
        .join("rect")
        .attr("class", "bar")
        .attr("x", 0)
        .attr("y", d => y(d.term))
        .attr("height", y.bandwidth())
        .attr("width", d => x(d.mean_tfidf))
        .attr("rx", 3)
        .on("mousemove", (event, d) => showTooltip(event,
            `<strong>${escapeHtml(d.term)}</strong><br>mean TF-IDF ${d.mean_tfidf.toFixed(4)}<br>in ${d.doc_freq} passages`))
        .on("mouseleave", hideTooltip);

    g.append("g")
        .attr("class", "axis")
        .attr("transform", `translate(0,${height - 20})`)
        .call(d3.axisBottom(x).ticks(4).tickFormat(d3.format(".3f")).tickSizeOuter(0));
}


// ---------------------------------------------------------------------------
// 2. View 1 - semantic embedding map
// ---------------------------------------------------------------------------

function drawSemanticMap(passages, byId, topicName) {
    const pad = 24;
    const x = d3.scaleLinear().domain(d3.extent(passages, d => d.x)).range([pad, MAP_W - pad]);
    const y = d3.scaleLinear().domain(d3.extent(passages, d => d.y)).range([MAP_H - pad, pad]);
    const r = d3.scaleSqrt().domain([8, 180]).range([2.4, 7.5]);
    let zx = x, zy = y;

    const svg = d3.select("#semantic-map").append("svg")
        .attr("viewBox", `0 0 ${MAP_W} ${MAP_H}`)
        .attr("class", "map-svg");

    svg.append("defs").append("clipPath").attr("id", "map-clip")
        .append("rect").attr("width", MAP_W).attr("height", MAP_H);

    const background = svg.append("rect")
        .attr("class", "map-bg")
        .attr("width", MAP_W)
        .attr("height", MAP_H)
        .on("click", () => {
            state.selected = null;
            refresh();
        });

    const plot = svg.append("g").attr("clip-path", "url(#map-clip)");
    const linkLayer = plot.append("g");
    const pointLayer = plot.append("g");
    const labelLayer = plot.append("g").attr("pointer-events", "none");

    // draw long passages first so short ones stay clickable on top
    const ordered = passages.slice().sort((a, b) => b.word_count - a.word_count);

    const points = pointLayer.selectAll(".passage")
        .data(ordered, d => d.passage_id)
        .join("circle")
        .attr("class", "passage")
        .attr("r", d => r(d.word_count))
        .attr("fill", d => TOPIC_COLORS[d.cluster])
        .on("mousemove", (event, d) => showTooltip(event,
            `${topicChip(d.cluster, d.cluster_name)}<br>
             <strong>${escapeHtml(d.matrix_section)}</strong> · p.${d.page} · ${d.word_count} words<br>
             <span class="tip-text">${escapeHtml(d.text.slice(0, 140))}${d.text.length > 140 ? "…" : ""}</span>`))
        .on("mouseleave", hideTooltip)
        .on("click", (event, d) => {
            event.stopPropagation();
            state.selected = state.selected === d.passage_id ? null : d.passage_id;
            refresh();
        });

    // topic names at each cluster's median position (secondary encoding for hue)
    const centres = d3.groups(passages, d => d.cluster).map(([c, v]) => ({
        cluster: c,
        x: d3.median(v, d => d.x),
        y: d3.median(v, d => d.y),
    }));
    const labels = labelLayer.selectAll(".topic-label")
        .data(centres)
        .join("text")
        .attr("class", "topic-label")
        .attr("text-anchor", "middle")
        .text(d => TOPIC_SHORT[d.cluster]);

    function position() {
        points.attr("cx", d => zx(d.x)).attr("cy", d => zy(d.y));
        // keep on-screen labels inside the frame (≈6px per character, half each side)
        labels.attr("x", d => {
            const px = zx(d.x), half = TOPIC_SHORT[d.cluster].length * 3.2 + 4;
            return px < 0 || px > MAP_W ? px : Math.min(Math.max(px, half), MAP_W - half);
        }).attr("y", d => zy(d.y));
        drawLinks();
    }

    function drawLinks() {
        const sel = state.selected ? byId.get(state.selected) : null;
        const links = sel ? sel.neighbors.map(id => ({ source: sel, target: byId.get(id) })) : [];
        linkLayer.selectAll("line")
            .data(links)
            .join("line")
            .attr("class", "neighbor-link")
            .attr("x1", d => zx(d.source.x))
            .attr("y1", d => zy(d.source.y))
            .attr("x2", d => zx(d.target.x))
            .attr("y2", d => zy(d.target.y));
    }

    svg.call(d3.zoom()
        .scaleExtent([1, 14])
        .translateExtent([[0, 0], [MAP_W, MAP_H]])
        .on("zoom", event => {
            zx = event.transform.rescaleX(x);
            zy = event.transform.rescaleY(y);
            position();
        }));

    drawMapLegends(r, topicName);
    position();

    return {
        update() {
            const sel = state.selected ? byId.get(state.selected) : null;
            const nbrs = new Set(sel ? sel.neighbors : []);
            points
                .attr("opacity", d => (passes(d) || d === sel || nbrs.has(d.passage_id)) ? 0.9 : DIM_OPACITY)
                .classed("is-selected", d => d === sel)
                .classed("is-neighbor", d => nbrs.has(d.passage_id))
                .attr("r", d => r(d.word_count) + (d === sel ? 3 : nbrs.has(d.passage_id) ? 1.5 : 0));
            points.filter(d => d === sel || nbrs.has(d.passage_id)).raise();
            labels.attr("opacity", d => (state.topic === "all" || +state.topic === d.cluster) ? 1 : 0.25);
            d3.selectAll("#topic-legend .legend-chip")
                .classed("is-off", d => state.topic !== "all" && +state.topic !== d.cluster);
            drawLinks();
        },
    };
}

function drawMapLegends(r, topicName) {
    d3.select("#topic-legend")
        .selectAll(".legend-chip")
        .data(TOPIC_ORDER.map(c => ({ cluster: c, name: topicName.get(c) })))
        .join("button")
        .attr("type", "button")
        .attr("class", "legend-chip legend-button")
        .html(d => `<span class="swatch" style="background:${TOPIC_COLORS[d.cluster]}"></span>${escapeHtml(d.name)}`)
        .on("click", (event, d) => {
            state.topic = state.topic === String(d.cluster) ? "all" : String(d.cluster);
            d3.select("#topic-filter").property("value", state.topic);
            state.cell = null;
            refresh();
        });

    const sizes = [20, 80, 180];
    const s = d3.select("#size-legend").append("svg").attr("width", 170).attr("height", 30);
    let cx = 10;
    sizes.forEach(w => {
        const rad = r(w);
        s.append("circle").attr("cx", cx + rad).attr("cy", 13).attr("r", rad).attr("class", "legend-dot");
        s.append("text").attr("x", cx + rad * 2 + 4).attr("y", 17).attr("class", "legend-text").text(w);
        cx += rad * 2 + 36;
    });

    d3.select("#select-legend").html(`
        <span class="legend-chip"><svg width="20" height="20"><circle cx="10" cy="10" r="7" class="legend-dot is-selected"></circle></svg>selected passage</span>
        <span class="legend-chip"><svg width="20" height="20"><circle cx="10" cy="10" r="5" class="legend-dot is-neighbor"></circle></svg>5 nearest neighbours</span>
        <span class="legend-chip"><svg width="26" height="10"><line x1="1" x2="25" y1="5" y2="5" class="neighbor-link"></line></svg>similarity link</span>`);
}


// ---------------------------------------------------------------------------
// 3. Detail panel
// ---------------------------------------------------------------------------

function renderPanel(passages, byId, topicName, topics) {
    const panel = d3.select("#detail-panel");

    if (state.selected) {
        const d = byId.get(state.selected);
        const path = [d.chapter, d.section, d.subsection, d.heading].filter(Boolean);
        const nbrs = d.neighbors.map((id, i) => ({ p: byId.get(id), sim: d.neighbor_sims[i] }));
        panel.html(`
            <div class="panel-kicker">Selected passage · ${d.passage_id}</div>
            <div class="crumbs">${path.map(escapeHtml).join(" <span>›</span> ")}</div>
            <dl class="facts">
                <dt>Chapter</dt><dd>${escapeHtml(d.chapter)}</dd>
                <dt>Section</dt><dd>${escapeHtml(d.section || "(chapter introduction)")}</dd>
                <dt>Subsection</dt><dd>${escapeHtml(d.subsection || "—")}</dd>
                <dt>Matrix row</dt><dd>${escapeHtml(d.matrix_section)}</dd>
                <dt>Page</dt><dd>${d.page}</dd>
                <dt>Topic</dt><dd>${topicChip(d.cluster, d.cluster_name)}</dd>
                <dt>Length</dt><dd>${d.word_count} words${d.kind === "table" ? " (course table)" : ""}</dd>
                <dt>Typicality</dt><dd>${d.section_typicality.toFixed(2)} <span class="muted">similarity to its section's average passage</span></dd>
            </dl>
            <p class="passage-text">${escapeHtml(d.text)}</p>
            <h4>5 most similar passages</h4>
            <ol class="neighbor-list">
                ${nbrs.map(n => `
                    <li data-id="${n.p.passage_id}" class="${n.p.matrix_section !== d.matrix_section ? "cross" : ""}">
                        <div class="nb-head">
                            <span class="sim">${n.sim.toFixed(2)}</span>
                            ${topicChip(n.p.cluster, TOPIC_SHORT[n.p.cluster])}
                        </div>
                        <div class="nb-meta">${escapeHtml(n.p.chapter_short)} › ${escapeHtml(n.p.matrix_section)} · p.${n.p.page}
                            ${n.p.matrix_section !== d.matrix_section ? '<span class="cross-tag">different section</span>' : ""}</div>
                        <div class="nb-text">${escapeHtml(n.p.text.slice(0, 180))}${n.p.text.length > 180 ? "…" : ""}</div>
                    </li>`).join("")}
            </ol>
            <button type="button" class="link-button" id="panel-clear">Clear selection</button>`);
        panel.selectAll(".neighbor-list li").on("click", function () {
            state.selected = this.dataset.id;
            refresh();
        });
        panel.select("#panel-clear").on("click", () => {
            state.selected = null;
            refresh();
        });
        return;
    }

    const matching = passages.filter(d => passes(d));
    const active = state.query || state.section !== "all" || state.topic !== "all" || state.cell;

    if (active) {
        let title = "Matching passages";
        if (state.cell) {
            title = `${escapeHtml(state.cell.row)} × ${escapeHtml(TOPIC_SHORT[state.cell.topic])}`;
        }
        const shown = matching.slice(0, 60);
        panel.html(`
            <div class="panel-kicker">${state.cell ? "Matrix cell" : "Current filter"}</div>
            <h4 class="panel-title">${title}</h4>
            <p class="muted">${matching.length} passage${matching.length === 1 ? "" : "s"}${matching.length > shown.length ? ` (first ${shown.length} listed)` : ""}. Click one to open it.</p>
            <ul class="match-list">
                ${shown.map(d => `
                    <li data-id="${d.passage_id}">
                        <div class="nb-head">${topicChip(d.cluster, TOPIC_SHORT[d.cluster])}</div>
                        <div class="nb-meta">${escapeHtml(d.matrix_section)} · p.${d.page}</div>
                        <div class="nb-text">${escapeHtml(d.text.slice(0, 150))}${d.text.length > 150 ? "…" : ""}</div>
                    </li>`).join("")}
            </ul>`);
        panel.selectAll(".match-list li").on("click", function () {
            state.selected = this.dataset.id;
            refresh();
        });
        return;
    }

    // default: how the topics were labelled
    const ordered = TOPIC_ORDER.map(c => topics.find(t => t.cluster === c));
    panel.html(`
        <div class="panel-kicker">Details on demand</div>
        <p>Click any point to read the passage, see where it sits in the bulletin, and follow its five nearest semantic neighbours.</p>
        <h4>The ten topics</h4>
        <p class="muted">KMeans clusters of the 384-d embeddings, labelled from their most central passages and characteristic (class-based TF-IDF) terms.</p>
        <ul class="topic-list">
            ${ordered.map(t => `
                <li data-cluster="${t.cluster}">
                    <div>${topicChip(t.cluster, t.cluster_name)} <span class="muted">${t.n}</span></div>
                    <div class="nb-text">${escapeHtml(t.top_terms)}</div>
                </li>`).join("")}
        </ul>`);
    panel.selectAll(".topic-list li").on("click", function () {
        state.topic = this.dataset.cluster;
        d3.select("#topic-filter").property("value", state.topic);
        state.cell = null;
        refresh();
    });
}


// ---------------------------------------------------------------------------
// 4. View 2 - Topic x Section matrix
// ---------------------------------------------------------------------------

function drawMatrix(passages, matrix, topicName) {
    const labelW = 250, cellW = 70, headerH = 78, barW = 90, entW = 60;
    const container = d3.select("#topic-matrix");
    const svg = container.append("svg").attr("class", "matrix-svg");
    const root = svg.append("g");

    // static row metadata for both levels (document order, totals, entropy)
    const rowMeta = {};
    for (const level of ["chapter", "section"]) {
        rowMeta[level] = Array.from(
            d3.group(matrix.filter(m => m.level === level), m => m.row),
            ([row, v]) => ({ row, order: v[0].row_order, chapter: v[0].chapter_short, total: v[0].row_total, entropy: v[0].row_entropy })
        ).sort((a, b) => a.order - b.order);
    }
    const topicTotals = d3.rollup(passages, v => v.length, d => d.cluster);

    function update() {
        const level = state.level;
        const rows = rowMeta[level];
        const cellH = level === "chapter" ? 30 : 17;
        const width = labelW + TOPIC_ORDER.length * cellW + 16 + barW + entW;
        const height = headerH + rows.length * cellH + 10;
        svg.attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height);

        // counts: all passages, or only search matches while a search is active
        const counting = state.query
            ? passages.filter(d => d.text.toLowerCase().includes(state.query))
            : passages;
        const counts = d3.rollup(counting, v => v.length, d => rowKey(d, level), d => d.cluster);
        const rowCounted = d3.rollup(counting, v => v.length, d => rowKey(d, level));
        const maxCell = d3.max(Array.from(counts.values()), m => d3.max(Array.from(m.values()))) || 1;

        const sel = state.selected ? passages.find(d => d.passage_id === state.selected) : null;
        const selKey = sel ? `${rowKey(sel, level)}|${sel.cluster}` : null;
        const nbrKeys = new Set(sel ? sel.neighbors
            .map(id => passages.find(d => d.passage_id === id))
            .map(p => `${rowKey(p, level)}|${p.cluster}`)
            .filter(k => k !== selKey) : []);
        const cellKey = state.cell && state.cell.level === level ? `${state.cell.row}|${state.cell.topic}` : null;

        const secFilter = state.section === "all" ? null : state.section;
        const rowActive = r => !secFilter
            || (secFilter.startsWith("ch:") && r.chapter === secFilter.slice(3))
            || (secFilter.startsWith("sec:") && level === "section" && r.row === secFilter.slice(4))
            || (secFilter.startsWith("sec:") && level === "chapter"
                && passages.some(d => d.matrix_section === secFilter.slice(4) && d.chapter_short === r.row));
        const colActive = c => state.topic === "all" || +state.topic === c;

        const cells = [];
        rows.forEach((r, i) => TOPIC_ORDER.forEach((c, j) => {
            const n = counts.get(r.row)?.get(c) || 0;
            const denom = state.query ? maxCell : r.total;
            cells.push({
                row: r.row, rowInfo: r, topic: c, i, j, n,
                share: n / denom,
                rowShare: n / (state.query ? (rowCounted.get(r.row) || 1) : r.total),
                colShare: n / (state.query ? d3.sum(counting, d => d.cluster === c) || 1 : topicTotals.get(c)),
                key: `${r.row}|${c}`,
            });
        }));

        // --- column headers
        root.selectAll(".col-head")
            .data(TOPIC_ORDER, c => c)
            .join(enter => {
                const g = enter.append("g").attr("class", "col-head");
                g.append("rect").attr("class", "col-hit");
                g.append("rect").attr("class", "col-swatch");
                g.append("text").attr("class", "col-label");
                g.append("text").attr("class", "col-total");
                return g;
            })
            .attr("transform", (c, j) => `translate(${labelW + j * cellW},0)`)
            .classed("is-off", c => !colActive(c))
            .each(function (c) {
                const g = d3.select(this);
                g.select(".col-hit").attr("width", cellW - 2).attr("height", headerH - 4).style("fill", "transparent");
                g.select(".col-swatch").attr("x", 4).attr("y", 6).attr("width", cellW - 10).attr("height", 5)
                    .attr("rx", 2).style("fill", TOPIC_COLORS[c]);
                const lines = wrapLines(TOPIC_SHORT[c], 11);
                g.select(".col-label").selectAll("tspan")
                    .data(lines)
                    .join("tspan")
                    .attr("x", 4)
                    .attr("y", (l, k) => 26 + k * 12)
                    .text(l => l);
                g.select(".col-total").attr("x", 4).attr("y", headerH - 8)
                    .text(`n=${state.query ? d3.sum(counting, d => d.cluster === c) : topicTotals.get(c)}`);
            })
            .on("click", (event, c) => {
                state.topic = state.topic === String(c) ? "all" : String(c);
                d3.select("#topic-filter").property("value", state.topic);
                state.cell = null;
                refresh();
            })
            .on("mousemove", (event, c) => showTooltip(event, `${topicChip(c, topicName.get(c))}<br>click to filter by this topic`))
            .on("mouseleave", hideTooltip);

        // --- row labels (with chapter separators in section mode)
        const rowG = root.selectAll(".row-head")
            .data(rows, r => r.row)
            .join(enter => {
                const g = enter.append("g").attr("class", "row-head");
                g.append("rect").attr("class", "row-hit");
                g.append("text").attr("class", "row-chapter");
                g.append("text").attr("class", "row-label");
                g.append("rect").attr("class", "row-bar");
                g.append("text").attr("class", "row-total");
                g.append("text").attr("class", "row-entropy");
                return g;
            })
            .attr("transform", (r, i) => `translate(0,${headerH + i * cellH})`)
            .classed("is-off", r => !rowActive(r));

        const barX = labelW + TOPIC_ORDER.length * cellW + 16;
        const xBar = d3.scaleLinear().domain([0, d3.max(rows, r => r.total)]).range([0, barW - 34]);

        rowG.each(function (r, i) {
            const g = d3.select(this);
            const firstOfChapter = i === 0 || rows[i - 1].chapter !== r.chapter;
            g.select(".row-hit").attr("width", labelW - 4).attr("height", cellH - 2).style("fill", "transparent");
            g.select(".row-chapter")
                .attr("x", 0).attr("y", cellH / 2).attr("dy", "0.35em")
                .text(level === "section" && firstOfChapter ? r.chapter.split(" ")[0] : "");
            g.select(".row-label")
                .attr("x", labelW - 8).attr("y", cellH / 2).attr("dy", "0.35em")
                .attr("text-anchor", "end")
                .text(r.row.length > 36 ? r.row.slice(0, 35) + "…" : r.row);
            g.select(".row-bar").attr("x", barX).attr("y", cellH * 0.22)
                .attr("height", cellH * 0.56).attr("width", xBar(r.total)).attr("rx", 2);
            g.select(".row-total").attr("x", barX + xBar(r.total) + 4).attr("y", cellH / 2).attr("dy", "0.35em")
                .text(r.total);
            g.select(".row-entropy").attr("x", barX + barW + 6).attr("y", cellH / 2).attr("dy", "0.35em")
                .text(r.entropy.toFixed(2));
        })
            .on("click", (event, r) => {
                const value = level === "chapter" ? `ch:${r.row}` : `sec:${r.row}`;
                state.section = state.section === value ? "all" : value;
                d3.select("#section-filter").property("value", state.section);
                state.cell = null;
                refresh();
            })
            .on("mousemove", (event, r) => showTooltip(event,
                `<strong>${escapeHtml(r.row)}</strong><br>${r.total} passages · diversity ${r.entropy.toFixed(2)} bits<br>click to filter by this ${level}`))
            .on("mouseleave", hideTooltip);

        // chapter separators
        const seps = level === "section"
            ? rows.map((r, i) => ({ i, r })).filter(({ i, r }) => i > 0 && rows[i - 1].chapter !== r.chapter)
            : [];
        root.selectAll(".chapter-sep")
            .data(seps, s => s.r.row)
            .join("line")
            .attr("class", "chapter-sep")
            .attr("x1", 0)
            .attr("x2", width - 4)
            .attr("y1", s => headerH + s.i * cellH - 1)
            .attr("y2", s => headerH + s.i * cellH - 1);

        // marginal headers
        root.selectAll(".margin-head")
            .data([{ x: barX, t: ["Passages", "in row"] }, { x: barX + barW + 6, t: ["Diversity", "(bits)"] }])
            .join("text")
            .attr("class", "margin-head col-label")
            .attr("x", d => d.x)
            .attr("y", 26)
            .selectAll("tspan")
            .data(d => d.t.map(t => ({ t, x: d.x })))
            .join("tspan")
            .attr("x", d => d.x)
            .attr("dy", (d, k) => k === 0 ? 0 : 12)
            .text(d => d.t);

        // --- cells
        const cellG = root.selectAll(".cell")
            .data(cells, d => d.key)
            .join(enter => {
                const g = enter.append("g").attr("class", "cell");
                g.append("rect").attr("class", "cell-rect");
                g.append("text").attr("class", "cell-value");
                return g;
            })
            .attr("transform", d => `translate(${labelW + d.j * cellW},${headerH + d.i * cellH})`)
            .classed("is-off", d => !rowActive(d.rowInfo) || !colActive(d.topic))
            .classed("is-picked", d => d.key === cellKey || d.key === selKey)
            .classed("is-neighbor-cell", d => nbrKeys.has(d.key));

        cellG.select(".cell-rect")
            .attr("x", 1).attr("y", 1)
            .attr("width", cellW - 2).attr("height", cellH - 2)
            .attr("rx", 3)
            .style("fill", d => d.n === 0 ? EMPTY_CELL : MATRIX_SHADE(0.08 + 0.92 * d.share));

        cellG.select(".cell-value")
            .attr("x", cellW / 2).attr("y", cellH / 2).attr("dy", "0.35em")
            .attr("text-anchor", "middle")
            .attr("fill", d => d.share > 0.45 ? "#fff" : "#222")
            .style("font-size", level === "chapter" ? "12px" : "10px")
            .text(d => d.n || "");

        cellG.on("mousemove", (event, d) => showTooltip(event, `
                <strong>${escapeHtml(d.row)}</strong><br>
                ${topicChip(d.topic, topicName.get(d.topic))}<br>
                ${d.n} passage${d.n === 1 ? "" : "s"}${state.query ? ` containing “${escapeHtml(state.query)}”` : ""}<br>
                ${fmtPct(d.rowShare)} of the row · ${fmtPct(d.colShare)} of the topic`))
            .on("mouseleave", hideTooltip)
            .on("click", (event, d) => {
                if (d.n === 0) return;
                const same = state.cell && state.cell.level === level && state.cell.row === d.row && state.cell.topic === d.topic;
                state.cell = same ? null : { level, row: d.row, topic: d.topic };
                state.selected = null;
                refresh();
            });

        d3.select("#matrix-note").html(state.query
            ? `Counting only passages containing <strong>“${escapeHtml(state.query)}”</strong> (${counting.length} passages); shade is relative to the largest cell.`
            : "");
    }

    drawMatrixLegend();
    return { update };
}

function drawMatrixLegend() {
    const w = 220, h = 34;
    const svg = d3.select("#matrix-legend").append("svg").attr("width", w + 20).attr("height", h);
    const grad = svg.append("defs").append("linearGradient").attr("id", "shade-grad");
    d3.range(0, 1.01, 0.1).forEach(t => grad.append("stop")
        .attr("offset", `${t * 100}%`).attr("stop-color", MATRIX_SHADE(0.08 + 0.92 * t)));
    svg.append("rect").attr("x", 4).attr("y", 2).attr("width", w).attr("height", 12).attr("rx", 3)
        .style("fill", "url(#shade-grad)");
    [0, 0.5, 1].forEach(t => svg.append("text").attr("class", "legend-text")
        .attr("x", 4 + t * w).attr("y", 28).attr("text-anchor", t === 0 ? "start" : t === 1 ? "end" : "middle")
        .text(fmtPct(t)));

    d3.select("#matrix-outline-legend").html(`
        <span class="legend-chip"><span class="swatch" style="background:${EMPTY_CELL}"></span>no passages</span>
        <span class="legend-chip"><svg width="22" height="16"><rect x="2" y="2" width="18" height="12" rx="3" class="legend-picked"></rect></svg>clicked cell / selected passage</span>
        <span class="legend-chip"><svg width="22" height="16"><rect x="2" y="2" width="18" height="12" rx="3" class="legend-nb"></rect></svg>its neighbours' cells</span>`);
}


// ---------------------------------------------------------------------------
// 5. Controls
// ---------------------------------------------------------------------------

function buildControls(passages, topicName) {
    d3.select("#search").on("input", function () {
        state.query = this.value.toLowerCase().trim();
        refresh();
    });

    // Section filter: whole chapter, or one matrix row inside it
    const chapters = d3.groups(passages, d => d.chapter_short)
        .sort((a, b) => a[1][0].chapter_num - b[1][0].chapter_num);
    const sel = d3.select("#section-filter");
    sel.append("option").attr("value", "all").text("All sections");
    chapters.forEach(([ch, v]) => {
        const group = sel.append("optgroup").attr("label", ch);
        group.append("option").attr("value", `ch:${ch}`).text(`All of ${ch}`);
        Array.from(new Set(v.map(d => d.matrix_section))).forEach(s =>
            group.append("option").attr("value", `sec:${s}`).text(s));
    });
    sel.on("change", function () {
        state.section = this.value;
        state.cell = null;
        refresh();
    });

    const tsel = d3.select("#topic-filter");
    tsel.append("option").attr("value", "all").text("All topics");
    TOPIC_ORDER.forEach(c => tsel.append("option").attr("value", String(c)).text(topicName.get(c)));
    tsel.on("change", function () {
        state.topic = this.value;
        state.cell = null;
        refresh();
    });

    d3.selectAll("input[name=level]").on("change", function () {
        state.level = this.value;
        state.cell = null;
        refresh();
    });

    d3.select("#btn-reset").on("click", () => {
        Object.assign(state, { query: "", section: "all", topic: "all", cell: null, selected: null });
        d3.select("#search").property("value", "");
        sel.property("value", "all");
        tsel.property("value", "all");
        refresh();
    });
}
