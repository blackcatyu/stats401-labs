"""
STATS 401 - Lab 8 (Step 1): Build a passage corpus from the DKU Bulletin

Extracts the text of the Bulletin of Duke Kunshan University Undergraduate
Instruction 2021-2022 and splits it into paragraph / short policy-block
passages, keeping the document hierarchy (chapter / section / subsection /
page) for every passage.

Source PDF (saved locally at ../data/lab8_dku_ug_bulletin_2021-22.pdf):
https://dku-web-admissions.s3.cn-north-1.amazonaws.com.cn/dkumain/files/V2021-22_DKU_UG_Bulletin.pdf
Accessed 2026-09-25.

How the hierarchy is recovered
------------------------------
The PDF carries a 5-level bookmark outline (1142 entries) whose destinations
include the page *and* the y-position of every heading. Each text block is
assigned to the most recent bookmark above it in reading order:

    level 1 -> chapter      e.g. "Part 6: Academic Procedures and Information"
    level 2 -> section      e.g. "Registration"
    level 3 -> subsection   e.g. "Academic Probation"
    level 4+ -> heading     (deepest heading, kept for context)

Scope
-----
Parts 1-10 up to (not including) "Course Descriptions" (p.217). The course
catalogue (~180 pages of one-paragraph course blurbs), the academic calendar
and the contact list are excluded: they are catalogue/table content rather
than prose about the university, and the course blurbs alone would outnumber
every policy passage and swamp the semantic topics.

Passage units
-------------
* one text block (a paragraph) = one passage
* a bulleted list is merged with the sentence that introduces it
* a paragraph broken by a page break is re-joined
* each requirement table (course code / name / credits) becomes one passage,
  prefixed by its heading, e.g. "Disciplinary Courses: COMPSCI 201 ..."
* long passages are split at sentence boundaries (~180 words max) so the
  embedding model (256 word-piece limit) sees the whole passage

Outputs (../data):
    lab8_passages_raw.csv     every extracted unit before cleaning
    lab8_passages.csv         cleaned corpus used by semantic_analysis.py
    lab8_corpus_stats.json    source info + counts at each cleaning step

Run from inside the lab8/ folder:
    python build_corpus.py

Requires: pymupdf, pandas, scikit-learn
"""

import json
import os
import re

import numpy as np
import pandas as pd
import pymupdf
from sklearn.feature_extraction.text import TfidfVectorizer

# ---------------------------------------------------------------------------
# Paths / settings
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "data")
PDF_PATH = os.path.join(DATA_DIR, "lab8_dku_ug_bulletin_2021-22.pdf")
RAW_PATH = os.path.join(DATA_DIR, "lab8_passages_raw.csv")
CLEAN_PATH = os.path.join(DATA_DIR, "lab8_passages.csv")
STATS_PATH = os.path.join(DATA_DIR, "lab8_corpus_stats.json")

FOOTER_Y = 730          # page numbers sit at y ~ 741
HEADING_SLACK = 8       # bookmark y is a few points above the heading text
MAX_WORDS = 180         # split longer passages at sentence boundaries
MIN_WORDS = 8           # drop fragments shorter than this after merging
NEAR_DUP = 0.9          # TF-IDF cosine at/above which a passage is a repeat
STOP_TITLE = "Course Descriptions"

BULLET_RE = re.compile(r"^[•●▪■–\-o]\s+")
END_PUNCT = tuple(".:;?!)\"”")


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def norm_key(s):
    """Loose key for matching a text line against a bookmark title."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


# ---------------------------------------------------------------------------
# 1. Outline -> ordered list of headings with (page, y)
# ---------------------------------------------------------------------------

def load_outline(doc):
    headings = []
    for level, title, page, dest in doc.get_toc(simple=False):
        y = dest.get("to").y if dest.get("to") is not None else 0
        headings.append({"level": level, "title": norm(title),
                         "page": page, "y": y})
    headings.sort(key=lambda h: (h["page"], h["y"]))
    return headings


def stop_position(headings):
    h = next(h for h in headings if h["title"] == STOP_TITLE)
    return h["page"], h["y"]


class HierarchyTracker:
    """Walks the outline in reading order and reports the current path."""

    def __init__(self, headings):
        self.headings = headings
        self.i = 0
        self.path = {}

    def advance(self, page, y):
        while (self.i < len(self.headings)
               and (self.headings[self.i]["page"], self.headings[self.i]["y"])
               <= (page, y + HEADING_SLACK)):
            h = self.headings[self.i]
            self.path[h["level"]] = h["title"]
            for deeper in [k for k in self.path if k > h["level"]]:
                del self.path[deeper]
            self.i += 1

    def current(self):
        deepest = max(self.path) if self.path else 0
        return {
            "chapter": self.path.get(1, ""),
            "section": self.path.get(2, ""),
            "subsection": self.path.get(3, ""),
            "heading": self.path.get(deepest, "") if deepest >= 4 else "",
        }


# ---------------------------------------------------------------------------
# 2. Page -> units (text blocks and tables) in reading order
# ---------------------------------------------------------------------------

def is_course_table(rows):
    """True for code/name/credit tables; False for boxed prose the table
    finder also picks up (e.g. the Data Science and Career Services boxes)."""
    rows = [[norm(c) for c in r if c and norm(c)] for r in rows]
    rows = [r for r in rows if r]
    credit_rows = sum(1 for r in rows
                      if len(r) >= 2 and re.fullmatch(r"\d+(\.\d+)?", r[-1]))
    return bool(rows) and credit_rows >= 0.3 * len(rows)


def table_to_text(rows, label):
    """Serialise a course-requirement table as one readable passage."""
    parts = []
    for row in rows:
        cells = [norm(c) for c in row if c and norm(c)]
        if not cells:
            continue
        joined = " ".join(cells)
        if norm_key(joined) in ("coursecodecoursenamecoursecredit",
                                "coursecodecoursenamecredits",
                                "coursecodecoursenamecredit"):
            continue
        # "MATH 101 | Introductory Calculus | 4" -> "MATH 101 Introductory Calculus (4)"
        if len(cells) >= 2 and re.fullmatch(r"\d+(\.\d+)?", cells[-1]):
            joined = " ".join(cells[:-1]) + f" ({cells[-1]} credits)"
        parts.append(joined)
    body = "; ".join(parts)
    return f"{label}: {body}" if label else body


def page_units(page, page_titles):
    units = []

    # boxed prose that the table finder also detects is left to the text
    # blocks below; only real course tables are serialised as tables
    tables = [t for t in page.find_tables().tables if is_course_table(t.extract())]
    table_boxes = [pymupdf.Rect(t.bbox) for t in tables]
    for t in tables:
        units.append({"y": t.bbox[1], "kind": "table", "rows": t.extract()})

    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        rect = pymupdf.Rect(b["bbox"])
        if rect.y0 >= FOOTER_Y:
            continue
        if any(rect.intersects(tb) and (rect & tb).get_area() > 0.5 * rect.get_area()
               for tb in table_boxes):
            continue
        lines = []
        bold_all = True
        for line in b["lines"]:
            text = "".join(s["text"] for s in line["spans"])
            if text.strip():
                lines.append(text)
                bold_all &= all("Bold" in s["font"] for s in line["spans"]
                                if s["text"].strip())
        text = norm(" ".join(lines))
        if not text or re.fullmatch(r"\d{1,3}", text):
            continue
        is_heading = (norm_key(text) in page_titles
                      or (bold_all and len(text.split()) <= 15
                          and not text.endswith(".")))
        units.append({"y": rect.y0, "kind": "heading" if is_heading else "text",
                      "text": text})

    units.sort(key=lambda u: u["y"])
    return units


# ---------------------------------------------------------------------------
# 3. Merge units into passages
# ---------------------------------------------------------------------------

def split_long(text, max_words=MAX_WORDS):
    words = text.split()
    if len(words) <= max_words:
        return [text]
    sentences = re.split(r"(?<=[.;?!])\s+(?=[A-Z(“\"])", text)
    chunks, current = [], []
    for s in sentences:
        if current and len(" ".join(current + [s]).split()) > max_words:
            chunks.append(" ".join(current))
            current = []
        current.append(s)
    if current:
        chunks.append(" ".join(current))
    # a single run-on "sentence" (e.g. a long table) -> hard split on words
    out = []
    for c in chunks:
        w = c.split()
        for i in range(0, len(w), max_words):
            out.append(" ".join(w[i:i + max_words]))
    return out


def build_passages(doc):
    headings = load_outline(doc)
    stop_page, stop_y = stop_position(headings)
    tracker = HierarchyTracker(headings)

    titles_by_page = {}
    for h in headings:
        titles_by_page.setdefault(h["page"], set()).add(norm_key(h["title"]))

    passages = []
    last_heading_text = ""

    def start(meta, page, text, kind):
        passages.append({**meta, "page": page, "text": text, "kind": kind})

    for pno in range(1, doc.page_count + 1):
        if pno > stop_page:
            break
        page = doc[pno - 1]
        for u in page_units(page, titles_by_page.get(pno, set())):
            if (pno, u["y"]) >= (stop_page, stop_y - HEADING_SLACK):
                break
            tracker.advance(pno, u["y"])
            meta = tracker.current()
            if not meta["chapter"]:
                continue  # cover, table of contents

            if u["kind"] == "heading":
                last_heading_text = u["text"]
                continue

            if u["kind"] == "table":
                label = meta["heading"] or meta["subsection"] or last_heading_text
                text = table_to_text(u["rows"], label)
                if text:
                    start(meta, pno, text, "table")
                continue

            text = u["text"]
            prev = passages[-1] if passages else None
            same_place = (prev is not None and prev["kind"] == "text"
                          and all(prev[k] == meta[k] for k in
                                  ("chapter", "section", "subsection", "heading")))

            is_bullet = bool(BULLET_RE.match(text))
            continues_sentence = (not prev["text"].endswith(END_PUNCT)
                                  and text[:1].islower()) if same_place else False
            intro_colon = same_place and prev["text"].endswith(":")

            if same_place and (is_bullet or continues_sentence or intro_colon
                               or prev.get("open_list")):
                if is_bullet:
                    text = BULLET_RE.sub("", text)
                    prev["open_list"] = True
                elif not text[:1].islower() and not intro_colon:
                    prev["open_list"] = False
                    start(meta, pno, text, "text")
                    continue
                prev["text"] = prev["text"] + " " + text
            else:
                start(meta, pno, BULLET_RE.sub("", text), "text")

    # expand long passages
    out = []
    for p in passages:
        p.pop("open_list", None)
        for chunk in split_long(p["text"]):
            out.append({**p, "text": chunk})
    return out


# ---------------------------------------------------------------------------
# 4. Clean
# ---------------------------------------------------------------------------

def clean(df):
    df = df.copy()
    df["text_clean"] = (
        df["text"]
        .str.replace(" ", " ", regex=False)
        .str.replace(r"\s+", " ", regex=True)
        .str.replace(r"(\w)- (\w)", r"\1\2", regex=True)   # "require- ments"
        .str.strip()
    )
    # footnote markers glued to words by the Word->PDF export, e.g. "2024)10F"
    df["text_clean"] = df["text_clean"].str.replace(r"(?<=[a-z\)])\d{1,2}F\b", "",
                                                    regex=True)
    df["word_count"] = df["text_clean"].str.split().str.len()

    stats = {"raw": len(df)}
    df = df.dropna(subset=["text_clean"])
    df = df[df["word_count"] >= MIN_WORDS]
    stats["after_short"] = len(df)
    df = df.drop_duplicates(subset=["text_clean"])
    stats["after_exact_dup"] = len(df)
    df = drop_near_duplicates(df)
    stats["after_near_dup"] = len(df)
    return df, stats


def drop_near_duplicates(df, threshold=NEAR_DUP):
    """Remove passages that repeat an earlier one almost verbatim: the same
    requirement table reprinted for several tracks of a major, or the
    Class-of-2022-24 and Class-of-2025 versions of the same policy."""
    X = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True
                        ).fit_transform(df["text_clean"])
    sim = (X @ X.T).toarray()
    keep, dropped = [], set()
    for i in range(len(df)):
        if i in dropped:
            continue
        keep.append(i)
        dropped.update(j for j in np.where(sim[i, i + 1:] >= threshold)[0] + i + 1)
    print(f"Near-duplicates removed (TF-IDF cosine >= {threshold}): {len(dropped)}")
    return df.iloc[keep]


def main():
    doc = pymupdf.open(PDF_PATH)
    raw = pd.DataFrame(build_passages(doc))
    raw.insert(0, "passage_id", [f"p{i:04d}" for i in range(1, len(raw) + 1)])
    raw.to_csv(RAW_PATH, index=False, encoding="utf-8")

    df, stats = clean(raw)
    df = df[["passage_id", "chapter", "section", "subsection", "heading",
             "page", "kind", "text_clean", "word_count"]]
    df.to_csv(CLEAN_PATH, index=False, encoding="utf-8")

    stats.update({
        "source_title": "Bulletin of Duke Kunshan University Undergraduate "
                        "Instruction 2021-2022",
        "source_url": "https://dku-web-admissions.s3.cn-north-1.amazonaws.com.cn"
                      "/dkumain/files/V2021-22_DKU_UG_Bulletin.pdf",
        "accessed": "2026-09-25",
        "pdf_pages": doc.page_count,
        "pages_used": f"{df['page'].min()}-{df['page'].max()}",
        "mean_words": round(float(df["word_count"].mean()), 1),
        "median_words": float(df["word_count"].median()),
        "n_chapters": int(df["chapter"].nunique()),
        "n_sections": int(df["section"].nunique()),
        "n_subsections": int(df["subsection"].replace("", pd.NA).nunique()),
        "n_table_passages": int((df["kind"] == "table").sum()),
    })
    with open(STATS_PATH, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(json.dumps(stats, indent=2))
    print(f"Raw passages:      {len(raw)}")
    print(f"After cleaning:    {len(df)}")
    print(f"Mean words:        {df['word_count'].mean():.1f}")
    print(f"Chapters:          {df['chapter'].nunique()}")
    print(f"Sections:          {df['section'].nunique()}")
    print(f"Subsections:       {df['subsection'].replace('', pd.NA).nunique()}")
    print()
    print(df.groupby("chapter", sort=False).size().to_string())


if __name__ == "__main__":
    main()
