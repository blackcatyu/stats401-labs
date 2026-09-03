// STATS 401 - Lab 3
// Loads the acquired dataset and renders it as a searchable, sortable HTML
// table, plus a few summary stats and a department breakdown.

d3.csv("../data/lab3_data.csv").then(function (data) {

    const columns = data.columns;

    // Decide which columns are numeric so we can sort them by value
    // instead of alphabetically ("100" should come after "9", not before).
    // A column is numeric only if every non-empty cell parses as a number.
    const numericColumns = new Set(
        columns.filter(function (col) {
            return data.every(function (row) {
                return row[col] === "" || !isNaN(row[col]);
            });
        })
    );

    let sortColumn = null;
    let ascending = true;
    let searchTerm = "";

    const table = d3.select("#data-table");
    const headerRow = table.select("thead").append("tr");
    const tbody = table.select("tbody");
    const rowCount = d3.select("#row-count");
    const searchInput = d3.select("#search-input");

    // --- Summary stats ------------------------------------------------------
    renderStats(data);
    renderDeptBreakdown(data);

    function renderStats(rows) {
        const artists = new Set(rows.map(function (d) { return d.artist; }).filter(Boolean));
        const departments = new Set(rows.map(function (d) { return d.department; }).filter(Boolean));
        const years = rows
            .map(function (d) { return +d.year; })
            .filter(function (y) { return !isNaN(y); });

        const stats = [
            { label: "Total artworks", value: rows.length.toLocaleString() },
            { label: "Unique artists", value: artists.size.toLocaleString() },
            { label: "Departments", value: departments.size.toLocaleString() },
            {
                label: "Year range",
                value: years.length ? `${d3.min(years)}–${d3.max(years)}` : "—"
            }
        ];

        d3.select("#stats-row")
            .selectAll(".stat")
            .data(stats)
            .join("div")
            .attr("class", "stat")
            .html(function (d) { return `<strong>${d.value}</strong><span>${d.label}</span>`; });
    }

    function renderDeptBreakdown(rows) {
        const counts = Array.from(
            d3.rollup(
                rows.filter(function (d) { return d.department; }),
                function (v) { return v.length; },
                function (d) { return d.department; }
            ),
            function ([department, count]) { return { department, count }; }
        ).sort(function (a, b) { return b.count - a.count; });

        const max = d3.max(counts, function (d) { return d.count; }) || 1;

        d3.select("#dept-chart")
            .selectAll(".dept-bar-row")
            .data(counts)
            .join("div")
            .attr("class", "dept-bar-row")
            .html(function (d) {
                const pct = (d.count / max) * 100;
                return `
                    <span class="dept-bar-name" title="${d.department}">${d.department}</span>
                    <span class="dept-bar-track"><span class="dept-bar-fill" style="width:${pct}%"></span></span>
                    <span class="dept-bar-count">${d.count.toLocaleString()}</span>
                `;
            });
    }

    // --- Build the clickable header ---------------------------------------
    headerRow.selectAll("th")
        .data(columns)
        .join("th")
        .text(function (d) { return d; })
        .on("click", function (event, column) {

            // Same column again -> flip direction. New column -> ascending.
            if (sortColumn === column) {
                ascending = !ascending;
            } else {
                sortColumn = column;
                ascending = true;
            }

            updateHeaderIndicators();
            render();
        });

    // --- Show a small arrow on the sorted column --------------------------
    function updateHeaderIndicators() {
        headerRow.selectAll("th")
            .text(function (d) {
                if (d === sortColumn) {
                    return d + (ascending ? "  ▲" : "  ▼");
                }
                return d;
            });
    }

    // --- Search box ----------------------------------------------------------
    searchInput.on("input", function () {
        searchTerm = this.value.trim().toLowerCase();
        render();
    });

    // --- Filter + sort + redraw --------------------------------------------
    function render() {
        let rows = data;

        if (searchTerm) {
            rows = rows.filter(function (row) {
                return columns.some(function (col) {
                    return String(row[col] || "").toLowerCase().includes(searchTerm);
                });
            });
        }

        if (sortColumn) {
            rows = rows.slice().sort(function (a, b) {
                let av = a[sortColumn];
                let bv = b[sortColumn];

                if (numericColumns.has(sortColumn)) {
                    av = parseFloat(av);
                    bv = parseFloat(bv);
                }

                const comparison = av > bv ? 1 : (av < bv ? -1 : 0);
                return ascending ? comparison : -comparison;
            });
        }

        rowCount.text(`Showing ${rows.length.toLocaleString()} of ${data.length.toLocaleString()} artworks`);
        updateRows(rows);
    }

    // --- (Re)draw the table body ------------------------------------------
    function updateRows(rows) {
        if (rows.length === 0) {
            tbody.selectAll("tr")
                .data([true])
                .join("tr")
                .attr("class", "no-results")
                .selectAll("td")
                .data([`No artworks match "${searchInput.property("value")}".`])
                .join("td")
                .attr("colspan", columns.length)
                .text(function (d) { return d; });
            return;
        }

        const rowSelection = tbody.selectAll("tr")
            .data(rows, function (d) { return d.id; })
            .join("tr")
            .attr("class", null);

        rowSelection.selectAll("td")
            .data(function (row) {
                return columns.map(function (col) { return row[col]; });
            })
            .join("td")
            .attr("class", function (d) { return d ? null : "empty-cell"; })
            .text(function (d) { return d || "—"; });
    }

    // Initial render (unsorted, in the order they were scraped).
    render();
});
