"""
STATS 401 - Lab 8 (Step 2): Semantic embeddings, UMAP, topics

Reads the passage corpus written by build_corpus.py and produces every file
the D3 page needs:

    lab8_embedding_map.csv          one row per passage: hierarchy metadata,
                                    text, word count, topic, UMAP x/y, the
                                    5 nearest semantic neighbours, and how
                                    typical the passage is of its section
    lab8_topic_section_matrix.csv   passage counts per (row, topic) for both
                                    matrix granularities (chapter / section)
    lab8_topics.csv                 topic label, size, top c-TF-IDF terms,
                                    representative passage
    lab8_top_terms.csv              corpus-wide top TF-IDF terms

Pipeline
--------
1. all-MiniLM-L6-v2 sentence embeddings (384-d, L2-normalised)
2. cosine similarity -> 5 nearest neighbours per passage
3. KMeans on the original 384-d embeddings (k chosen from a silhouette
   sweep plus reading the clusters; see K and TOPIC_NAMES below)
4. UMAP (cosine, n_neighbors=15, min_dist=0.15) to 2-D for the map only
5. class-based TF-IDF (all passages of one cluster = one document) and the
   passages closest to each centroid, used to label the topics by hand

Run from inside the lab8/ folder:
    python semantic_analysis.py            # full run, writes the CSVs
    python semantic_analysis.py --explore  # silhouette sweep + cluster dump

Requires: sentence-transformers, umap-learn, scikit-learn, pandas
"""

import os
import re
import sys

import numpy as np
import pandas as pd

from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer, ENGLISH_STOP_WORDS
from sklearn.metrics import silhouette_score
import umap

# ---------------------------------------------------------------------------
# Paths / settings
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "data")
PASSAGES_PATH = os.path.join(DATA_DIR, "lab8_passages.csv")
MAP_PATH = os.path.join(DATA_DIR, "lab8_embedding_map.csv")
MATRIX_PATH = os.path.join(DATA_DIR, "lab8_topic_section_matrix.csv")
TOPICS_PATH = os.path.join(DATA_DIR, "lab8_topics.csv")
TERMS_PATH = os.path.join(DATA_DIR, "lab8_top_terms.csv")

MODEL_NAME = "all-MiniLM-L6-v2"
RANDOM_STATE = 401
K = 10
N_NEIGHBORS = 5
MIN_SECTION_PASSAGES = 5    # smaller sections -> "Other (Part N)" matrix row

# Hand-written labels, assigned after reading each cluster's representative
# passages and c-TF-IDF terms (python semantic_analysis.py --explore).
# KMeans is seeded, so the cluster ids are stable for this corpus; re-check
# the labels if the corpus or K changes.
# Silhouette is low for every k (0.09-0.14, highest at k=6); k=10 was kept
# because k=6 merges academic integrity into grading and leave into fees.
TOPIC_NAMES = {
    0: "Humanities & Social Sci. Electives",
    1: "Academic Integrity & Grievances",
    2: "Grading, CR/NC & Academic Standing",
    3: "Humanities & Social Sci. Major Courses",
    4: "Advising & Academic Support",
    5: "Campus Life & DKU Identity",
    6: "STEM Course Requirements",
    7: "Leave, Withdrawal & Fees",
    8: "Credit Transfer, Placement & Study Away",
    9: "Major Overviews & Tracks",
}

# Short chapter labels for the matrix rows / legends
CHAPTER_SHORT = {
    1: "P1 General Information",
    2: "P2 Liberal Arts Education",
    3: "P3 The Curriculum",
    4: "P4 Admission & Aid",
    5: "P5 Financial Information",
    6: "P6 Academic Procedures",
    7: "P7 Advising & Support",
    8: "P8 Careers, Study Away, Research",
    9: "P9 Student Affairs",
    10: "P10 Majors",
}

# Long formal section names shortened for the matrix row labels
SECTION_SHORT = {
    "Academic Warning, Probation, and Suspension for Students in the Classes of 2022-2024":
        "Academic Standing (Class 2022-24)",
    "Academic Warning, Probation, and Suspension for Students in the Class of 2025 and Beyond":
        "Academic Standing (Class 2025+)",
    "Procedure for Resolution of Students' Academic Concerns":
        "Resolving Academic Concerns",
    "Office of Global Education and Study Away": "Global Education & Study Away",
    "Applied Mathematics and Computational Sciences": "Applied Math & Comp. Sciences",
    "Transfer of Work Taken Elsewhere": "Transfer of Work Elsewhere",
    "Entrance Credit and Placement": "Entrance Credit & Placement",
    "Grading and Grade Requirements": "Grading & Grade Requirements",
    "Academic Recognition and Honors": "Recognition & Honors",
    "Athletics & University Sports": "Athletics & Sports",
}

# Extra stop words for the TF-IDF summaries: boilerplate that appears in
# nearly every passage of a bulletin and says nothing about the topic
BULLETIN_STOP = {
    "duke", "kunshan", "university", "dku", "students", "student", "course",
    "courses", "credits", "credit", "following", "choose", "complete", "000",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def chapter_number(chapter):
    m = re.match(r"Part (\d+)", chapter)
    return int(m.group(1)) if m else 0


def short_major(subsection):
    """'Data Science' / 'Applied Mathematics ... with tracks in ...' -> name."""
    name = re.split(r"\s+with\s+[Tt]racks?\b", subsection)[0]
    return name.strip()


def matrix_section(row):
    """Row label for the Section-granularity matrix.

    Level-2 sections everywhere, except inside "Majors (listed ...)", where
    each major (level 3) is its own row.
    """
    if row["section"].startswith("Majors"):
        name = short_major(row["subsection"]) or "Majors (overview)"
    elif row["section"]:
        name = row["section"]
    else:
        name = f"P{chapter_number(row['chapter'])} introduction"
    return SECTION_SHORT.get(name, name)


def ctfidf_terms(texts_by_cluster, top_n=10, stop=None):
    vec = TfidfVectorizer(stop_words=stop, ngram_range=(1, 2), min_df=1,
                          token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z]+\b",
                          sublinear_tf=True)
    X = vec.fit_transform(texts_by_cluster)
    vocab = np.array(vec.get_feature_names_out())
    return [list(vocab[np.argsort(X[i].toarray().ravel())[::-1][:top_n]])
            for i in range(X.shape[0])]


def entropy(counts):
    p = np.asarray(counts, dtype=float)
    p = p[p > 0] / p.sum()
    return abs(float(-(p * np.log2(p)).sum()))


# ---------------------------------------------------------------------------
# Main steps
# ---------------------------------------------------------------------------

def embed(texts):
    model = SentenceTransformer(MODEL_NAME)
    return model.encode(texts, normalize_embeddings=True,
                        batch_size=64, show_progress_bar=True)


def explore(df, emb, stop):
    print("\nSilhouette (cosine) by k:")
    for k in range(6, 16):
        labels = KMeans(n_clusters=k, random_state=RANDOM_STATE,
                        n_init="auto").fit_predict(emb)
        print(f"  k={k:2d}  {silhouette_score(emb, labels, metric='cosine'):.4f}")

    km = KMeans(n_clusters=K, random_state=RANDOM_STATE, n_init="auto").fit(emb)
    df = df.assign(cluster=km.labels_)
    terms = ctfidf_terms(
        [" ".join(df.loc[df.cluster == c, "text_clean"]) for c in range(K)],
        stop=stop)
    for c in range(K):
        idx = np.where(km.labels_ == c)[0]
        dist = emb[idx] @ km.cluster_centers_[c]
        sub = df.iloc[idx]
        print(f"\n=== CLUSTER {c}  (n={len(idx)})")
        print("terms:", ", ".join(terms[c]))
        print("chapters:", sub["chapter"].map(chapter_number)
              .value_counts().head(5).to_dict())
        print("sections:", sub["section"].str[:30].value_counts().head(5).to_dict())
        for i in idx[np.argsort(dist)[::-1][:6]]:
            print("  -", df.iloc[i]["text_clean"][:160])


def main():
    df = pd.read_csv(PASSAGES_PATH).fillna("")
    stop = list(ENGLISH_STOP_WORDS | BULLETIN_STOP)
    emb = embed(df["text_clean"].tolist())
    print("Embeddings:", emb.shape)

    if "--explore" in sys.argv:
        explore(df, emb, stop)
        return

    # --- nearest neighbours (cosine on normalised vectors = dot product)
    sim = emb @ emb.T
    np.fill_diagonal(sim, -1)
    nn_idx = np.argsort(-sim, axis=1)[:, :N_NEIGHBORS]
    ids = df["passage_id"].to_numpy()
    df["neighbors"] = ["|".join(ids[row]) for row in nn_idx]
    df["neighbor_sims"] = ["|".join(f"{sim[i, j]:.3f}" for j in row)
                           for i, row in enumerate(nn_idx)]

    # --- topics
    km = KMeans(n_clusters=K, random_state=RANDOM_STATE, n_init="auto").fit(emb)
    df["cluster"] = km.labels_
    df["cluster_name"] = df["cluster"].map(TOPIC_NAMES).fillna(
        df["cluster"].map(lambda c: f"Topic {c}"))
    print("Silhouette:", round(silhouette_score(emb, km.labels_, metric="cosine"), 4))

    # --- UMAP
    coords = umap.UMAP(n_components=2, n_neighbors=15, min_dist=0.15,
                       metric="cosine", random_state=RANDOM_STATE
                       ).fit_transform(emb)
    df["x"] = coords[:, 0].round(4)
    df["y"] = coords[:, 1].round(4)

    # --- formal-structure labels for the matrix
    df["chapter_num"] = df["chapter"].map(chapter_number)
    df["chapter_short"] = df["chapter_num"].map(CHAPTER_SHORT)
    df["matrix_section"] = df.apply(matrix_section, axis=1)
    sizes = df.groupby("matrix_section")["passage_id"].transform("size")
    small = sizes < MIN_SECTION_PASSAGES
    df.loc[small, "matrix_section"] = "Other (P" + df.loc[small, "chapter_num"].astype(str) + ")"

    # --- how typical is each passage of its formal section?
    # cosine similarity to the centroid of its matrix_section
    df["section_typicality"] = 0.0
    for _, idx in df.groupby("matrix_section").indices.items():
        centroid = emb[idx].mean(axis=0)
        centroid /= np.linalg.norm(centroid)
        df.loc[df.index[idx], "section_typicality"] = (emb[idx] @ centroid).round(4)

    # --- topic summary
    terms = ctfidf_terms(
        [" ".join(df.loc[df.cluster == c, "text_clean"]) for c in range(K)],
        stop=stop)
    topics = []
    for c in range(K):
        idx = np.where(km.labels_ == c)[0]
        rep = idx[np.argmax(emb[idx] @ km.cluster_centers_[c])]
        topics.append({
            "cluster": c,
            "cluster_name": df["cluster_name"].iloc[idx[0]],
            "n": len(idx),
            "top_terms": ", ".join(terms[c][:8]),
            "representative_id": ids[rep],
            "n_chapters": df.iloc[idx]["chapter_num"].nunique(),
        })
    pd.DataFrame(topics).to_csv(TOPICS_PATH, index=False, encoding="utf-8")

    # --- corpus-wide top TF-IDF terms
    vec = TfidfVectorizer(stop_words=stop, ngram_range=(1, 2), min_df=3,
                          token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z]+\b",
                          sublinear_tf=True)
    X = vec.fit_transform(df["text_clean"])
    scores = np.asarray(X.mean(axis=0)).ravel()
    top = np.argsort(scores)[::-1][:25]
    pd.DataFrame({"term": vec.get_feature_names_out()[top],
                  "mean_tfidf": scores[top].round(5),
                  "doc_freq": np.asarray((X[:, top] > 0).sum(axis=0)).ravel()}
                 ).to_csv(TERMS_PATH, index=False, encoding="utf-8")

    # --- topic x section matrix (both granularities, long format)
    # rows follow document order; merged "Other (Pn)" rows close their Part
    df["_is_other"] = df["matrix_section"].str.startswith("Other")
    rows = []
    for level, col in [("chapter", "chapter_short"), ("section", "matrix_section")]:
        order = (df.groupby(col)
                 .agg(ch=("chapter_num", "min"), other=("_is_other", "max"),
                      first=("passage_id", "min"))
                 .sort_values(["ch", "other", "first"]).index)
        counts = df.groupby([col, "cluster_name"]).size()
        for i, r in enumerate(order):
            row_counts = counts.loc[r]
            chap = df.loc[df[col] == r, "chapter_short"].iloc[0]
            for t, n in row_counts.items():
                rows.append({"level": level, "row": r, "row_order": i,
                             "chapter_short": chap, "cluster_name": t,
                             "count": int(n),
                             "row_total": int(row_counts.sum()),
                             "row_entropy": round(entropy(row_counts.values), 4)})
    pd.DataFrame(rows).to_csv(MATRIX_PATH, index=False, encoding="utf-8")

    # --- export the map data
    cols = ["passage_id", "chapter", "chapter_num", "chapter_short", "section",
            "subsection", "heading", "matrix_section", "page", "kind",
            "text_clean", "word_count", "cluster", "cluster_name", "x", "y",
            "neighbors", "neighbor_sims", "section_typicality"]
    df[cols].rename(columns={"text_clean": "text"}).to_csv(
        MAP_PATH, index=False, encoding="utf-8")

    print(f"Wrote {len(df)} passages, {K} topics, "
          f"{df['matrix_section'].nunique()} matrix sections")
    print(pd.DataFrame(topics)[["cluster", "cluster_name", "n", "n_chapters",
                                "top_terms"]].to_string(index=False))


if __name__ == "__main__":
    main()
