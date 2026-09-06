"""
STATS 401 - Lab 4: Cleaning Web Data for Visualization

Cleans a raw tweet dataset, builds a TF-IDF representation of the tweet
text (Path A), scores every tweet's sentiment with a Twitter-tuned RoBERTa
model (Path B), and exports a tidy dataset plus an airline-level aggregate
for the D3 visualization.

Dataset: Twitter US Airline Sentiment (Crowdflower, scraped Feb 2015).
Saved locally at ../data/lab4_raw_tweets.csv. Original source:
https://github.com/satyajeetkrjha/kaggle-Twitter-US-Airline-Sentiment-

Run from inside the lab4/ folder:
    python clean_tweets.py

Requires: pandas, scikit-learn, nltk, transformers, torch (see requirements.txt)
"""

import os
import re

import numpy as np
import pandas as pd

from sklearn.feature_extraction.text import TfidfVectorizer

import nltk
from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer
from nltk.tokenize import word_tokenize

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "data")
RAW_PATH = os.path.join(DATA_DIR, "lab4_raw_tweets.csv")
CLEAN_PATH = os.path.join(DATA_DIR, "lab4_clean_tweets.csv")
AGG_PATH = os.path.join(DATA_DIR, "lab4_sentiment_by_airline.csv")
TOP_TERMS_PATH = os.path.join(DATA_DIR, "lab4_top_tfidf_terms.csv")

# Set to an integer to score a stratified sample instead of every cleaned
# tweet (useful on CPU-only machines, where RoBERTa inference runs at
# roughly 10-30 tweets/second). None scores every record - fast enough on a
# GPU, and satisfies "sentiment computed for every record" exactly.
SAMPLE_SIZE = None
RANDOM_STATE = 401


def ensure_nltk_data():
    """Download the NLTK corpora we need, but only if they're missing."""
    required = [
        ("punkt", "tokenizers/punkt"),
        ("punkt_tab", "tokenizers/punkt_tab"),
        ("stopwords", "corpora/stopwords"),
        ("wordnet", "corpora/wordnet"),
        ("omw-1.4", "corpora/omw-1.4"),
    ]
    for package, path in required:
        try:
            nltk.data.find(path)
        except LookupError:
            nltk.download(package, quiet=True)


# ---------------------------------------------------------------------------
# 1. Load
# ---------------------------------------------------------------------------

def load_raw():
    return pd.read_csv(RAW_PATH)


# ---------------------------------------------------------------------------
# 2. Data quality assessment + cleaning
# ---------------------------------------------------------------------------

def clean(df):
    df = df.copy()
    n_start = len(df)

    # --- Missing data -------------------------------------------------------
    # `text` is the entire point of the dataset; a tweet with no text isn't a
    # usable record, so those rows are dropped outright.
    df = df.dropna(subset=["text"])

    # `retweet_count` missing would reasonably mean "not retweeted" -> 0. It
    # is never actually missing in this export, but we coerce + fill anyway
    # so the pipeline stays robust if a future re-scrape has gaps, and clip
    # any (unexpected) negative values since a tweet can't have -1 retweets.
    df["retweet_count"] = pd.to_numeric(df["retweet_count"], errors="coerce").fillna(0)
    n_negative_retweets = int((df["retweet_count"] < 0).sum())
    if n_negative_retweets:
        print(f"Warning: {n_negative_retweets} rows had a negative retweet_count; clipped to 0.")
    df["retweet_count"] = df["retweet_count"].clip(lower=0).astype(int)

    # `tweet_location` / `user_timezone` are free-text and self-reported, so
    # there's no principled value to impute - we label them explicitly
    # instead of leaving a blank cell that looks like a rendering bug.
    df["tweet_location"] = df["tweet_location"].fillna("Unknown").astype(str).str.strip()
    df["user_timezone"] = df["user_timezone"].fillna("Unknown").astype(str).str.strip()

    # `negativereason*` and the two `*_gold` columns are 94-99% empty (they
    # only apply to a subset of negative tweets, or were never populated by
    # the crowdsourcing platform) and aren't needed for this lab's two
    # visualization dimensions. `tweet_coord` is missing for 93% of rows
    # (most users don't share a precise geotag) - too sparse to be a usable
    # dimension. `name` (the poster's handle) isn't needed for the analysis,
    # so it's dropped rather than carried along.
    df = df.drop(columns=[
        "negativereason", "negativereason_confidence",
        "airline_sentiment_gold", "negativereason_gold",
        "tweet_coord", "name",
    ])

    # --- Deduplication -------------------------------------------------------
    # First collapse exact duplicate rows (a scrape/export artifact), then
    # collapse on tweet_id - the true business key, since a tweet can only
    # exist once - keeping the first occurrence.
    n_full_dupes = int(df.duplicated().sum())
    df = df.drop_duplicates()
    n_id_dupes = int(df.duplicated(subset=["tweet_id"]).sum())
    df = df.drop_duplicates(subset=["tweet_id"], keep="first")

    # --- Categorical standardization -----------------------------------------
    df["airline"] = df["airline"].str.strip()
    df["airline_sentiment"] = df["airline_sentiment"].str.strip().str.lower()

    # --- Date parsing ---------------------------------------------------------
    # Every row in this export uses "YYYY-MM-DD HH:MM:SS -0800"; format="mixed"
    # lets the parser fall back gracefully if a future re-scrape isn't as
    # uniform.
    parsed = pd.to_datetime(df["tweet_created"], format="mixed", errors="coerce", utc=True)
    n_bad_dates = int(parsed.isna().sum())
    if n_bad_dates:
        print(f"Warning: {n_bad_dates} rows had an unparseable tweet_created and were dropped.")
    df["tweet_created"] = parsed
    df = df.dropna(subset=["tweet_created"])
    df["date"] = df["tweet_created"].dt.date.astype(str)
    df["hour"] = df["tweet_created"].dt.hour
    df["weekday"] = df["tweet_created"].dt.day_name()

    # --- Text field cleaning ---------------------------------------------------
    # Keep the original text as-is for sentiment (which needs punctuation,
    # case, and emoji), just tidying up stray whitespace.
    df["text"] = df["text"].str.strip().str.replace(r"\s+", " ", regex=True)

    df = df.rename(columns={
        "airline_sentiment": "human_sentiment",
        "airline_sentiment_confidence": "human_sentiment_confidence",
    })

    n_dropped = n_start - len(df) - n_full_dupes - n_id_dupes
    print(
        f"Cleaning summary: {n_start} -> {len(df)} rows "
        f"({n_full_dupes} full duplicates, {n_id_dupes} duplicate tweet_ids, "
        f"{n_dropped} dropped for missing text/unparseable dates)."
    )

    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# 3. TF-IDF pipeline (Path A: aggressive preprocessing)
# ---------------------------------------------------------------------------

URL_RE = re.compile(r"https?://\S+")
MENTION_RE = re.compile(r"@\w+")
NUMBER_RE = re.compile(r"\b\d+\b")


def tfidf_normalize(text, lemmatizer, stop_words):
    text = text.lower()
    text = URL_RE.sub(" urltoken ", text)
    text = MENTION_RE.sub(" mentiontoken ", text)
    text = NUMBER_RE.sub(" numbertoken ", text)

    tokens = word_tokenize(text)
    tokens = [t for t in tokens if t.isalpha()]
    tokens = [t for t in tokens if t not in stop_words]
    tokens = [lemmatizer.lemmatize(t) for t in tokens]
    return " ".join(tokens)


def build_tfidf(df):
    lemmatizer = WordNetLemmatizer()
    stop_words = set(stopwords.words("english"))

    df = df.copy()
    df["clean_text"] = df["text"].apply(lambda t: tfidf_normalize(t, lemmatizer, stop_words))

    # min_df=2 drops one-off typos/noise; max_df=0.9 drops terms so common
    # (e.g. our own "urltoken"/"mentiontoken" placeholders) that they can't
    # distinguish one tweet from another.
    vectorizer = TfidfVectorizer(min_df=2, max_df=0.9)
    dtm = vectorizer.fit_transform(df["clean_text"])

    print(
        f"TF-IDF: vocabulary size = {len(vectorizer.vocabulary_)} terms "
        f"over {dtm.shape[0]} documents (min_df=2, max_df=0.9)."
    )

    # Not required for the visualization, but a useful sanity check on the
    # vocabulary: the terms with the highest summed TF-IDF weight overall.
    scores = np.asarray(dtm.sum(axis=0)).ravel()
    top_terms = (
        pd.Series(scores, index=vectorizer.get_feature_names_out())
        .sort_values(ascending=False)
        .head(25)
    )
    top_terms.to_csv(TOP_TERMS_PATH, header=["summed_tfidf"])

    return df


# ---------------------------------------------------------------------------
# 4. Sentiment analysis (Path B: RoBERTa)
# ---------------------------------------------------------------------------

def sentiment_normalize(text):
    # Light touch only: replace handles/URLs with the generic tokens the
    # model was trained on, but leave punctuation, casing, and emoji intact -
    # they carry emotional tone that RoBERTa relies on.
    text = MENTION_RE.sub("@user", text)
    text = URL_RE.sub("http", text)
    return text


def stratified_sample(df, sample_size, random_state):
    """Sample proportionally within each airline so the smallest airline
    (Virgin America, ~3% of tweets) isn't drowned out by simple random
    sampling."""
    if not sample_size or sample_size >= len(df):
        return df

    frac = sample_size / len(df)
    sampled = (
        df.groupby("airline", group_keys=False)[df.columns]
        .apply(lambda g: g.sample(frac=frac, random_state=random_state))
    )
    return sampled.reset_index(drop=True)


def score_sentiment(df, sample_size, random_state):
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    import torch
    from scipy.special import softmax

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        print(f"Using GPU: {torch.cuda.get_device_name(0)}")
    else:
        print("No GPU detected; running on CPU.")

    df = stratified_sample(df, sample_size, random_state)
    print(f"Scoring sentiment for {len(df)} tweets.")

    model_name = "cardiffnlp/twitter-roberta-base-sentiment-latest"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSequenceClassification.from_pretrained(model_name)
    model.to(device)
    model.eval()

    # Read the label order from the model config rather than hardcoding it,
    # in case a future model revision changes the class order.
    id2label = model.config.id2label
    labels = [id2label[i].lower() for i in range(len(id2label))]

    texts = df["text"].apply(sentiment_normalize).tolist()

    # A GPU can chew through much bigger batches than a CPU can.
    batch_size = 64 if device.type == "cuda" else 32

    all_probs = []
    with torch.no_grad():
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            encoded = tokenizer(batch, return_tensors="pt", truncation=True, padding=True, max_length=128)
            encoded = {k: v.to(device) for k, v in encoded.items()}
            logits = model(**encoded).logits.cpu().numpy()
            probs = softmax(logits, axis=1)
            all_probs.append(probs)
            done = min(i + batch_size, len(texts))
            if (i // batch_size) % 10 == 0 or done == len(texts):
                print(f"  scored {done}/{len(texts)} tweets")

    probs = np.vstack(all_probs)
    neg_idx, neu_idx, pos_idx = labels.index("negative"), labels.index("neutral"), labels.index("positive")

    df = df.copy()
    df["roberta_negative"] = probs[:, neg_idx]
    df["roberta_neutral"] = probs[:, neu_idx]
    df["roberta_positive"] = probs[:, pos_idx]
    df["roberta_label"] = [labels[i].capitalize() for i in probs.argmax(axis=1)]
    df["roberta_score"] = df["roberta_positive"] - df["roberta_negative"]

    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# 5. Aggregation for the D3 visualization
# ---------------------------------------------------------------------------

def build_aggregate(df):
    agg = (
        df.groupby("airline")
        .agg(
            n_tweets=("tweet_id", "count"),
            avg_sentiment=("roberta_score", "mean"),
            pct_negative=("roberta_label", lambda s: (s == "Negative").mean()),
            pct_neutral=("roberta_label", lambda s: (s == "Neutral").mean()),
            pct_positive=("roberta_label", lambda s: (s == "Positive").mean()),
            avg_retweets=("retweet_count", "mean"),
        )
        .reset_index()
        .sort_values("avg_sentiment")
    )
    return agg


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ensure_nltk_data()

    raw = load_raw()
    cleaned = clean(raw)
    cleaned = build_tfidf(cleaned)
    scored = score_sentiment(cleaned, SAMPLE_SIZE, RANDOM_STATE)

    export_cols = [
        "tweet_id", "date", "hour", "weekday",
        "airline", "tweet_location", "user_timezone", "retweet_count",
        "text", "clean_text",
        "human_sentiment", "human_sentiment_confidence",
        "roberta_negative", "roberta_neutral", "roberta_positive",
        "roberta_label", "roberta_score",
    ]
    scored[export_cols].to_csv(CLEAN_PATH, index=False)
    print(f"Saved {len(scored)} tidy rows to {CLEAN_PATH}")

    agg = build_aggregate(scored)
    agg.to_csv(AGG_PATH, index=False)
    print(f"Saved airline-level aggregate to {AGG_PATH}")


if __name__ == "__main__":
    main()
