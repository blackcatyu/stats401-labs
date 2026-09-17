"""
STATS 401 - Lab 6 Assignment: GDP Hierarchy to Hierarchical JSON

Converts the flat continent/area/country GDP dataset into nested JSON
(World -> continent -> area -> country) for the two D3 treemaps. Each
leaf (country) keeps its gdp_billion_usd and gdp_status.

Run from inside the lab6/ folder:
    python convert_hierarchy.py
"""

import os
import json

import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "data")
CSV_PATH = os.path.join(DATA_DIR, "lab6_assignment_gdp.csv")
JSON_PATH = os.path.join(DATA_DIR, "lab6_assignment_gdp.json")


def build_hierarchy(df, levels):
    if len(levels) == 1:
        return [
            {
                "name": row[levels[0]],
                "gdp": row["gdp_billion_usd"],
                "status": row["gdp_status"],
            }
            for _, row in df.iterrows()
        ]

    level = levels[0]
    children = []
    for value, group in df.groupby(level, sort=False):
        children.append({
            "name": value,
            "children": build_hierarchy(group, levels[1:]),
        })
    return children


def main():
    df = pd.read_csv(CSV_PATH)

    hierarchy = {
        "name": "World",
        "children": build_hierarchy(df, ["continent", "area", "country"]),
    }

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(hierarchy, f, indent=2, ensure_ascii=False)

    print(f"Saved hierarchical JSON to {JSON_PATH}")


if __name__ == "__main__":
    main()
