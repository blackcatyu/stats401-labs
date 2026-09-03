"""
STATS 401 - Lab 3: Web Data Acquisition
Fetches artwork records from the Art Institute of Chicago public API.

    https://api.artic.edu/api/v1/artworks

The API is public, free, and requires no API key. The museum asks that you
send a User-Agent that identifies your application, which we do below. The
data may be used for noncommercial educational and personal purposes.

The collection has 100,000+ artworks. We page through it 100 at a time
until we have collected 1,000 records, which satisfies the assignment.

For each artwork we keep six fields:
    - id          (numeric identifier)
    - title       (text)
    - artist      (text)
    - year        (numeric - the start year of creation)
    - type        (text - Painting, Sculpture, etc.)
    - department  (text - curatorial department)

The result is saved to ../data/lab3_data.csv

Run from inside the lab3/ folder:
    python fetch_artworks.py
"""

import os
import time

import requests
import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = "https://api.artic.edu/api/v1/artworks"

# Ask the API for only the fields we need. Requesting fewer fields is
# faster for us and lighter on the server.
FIELDS = "id,title,artist_title,date_start,artwork_type_title,department_title"

# 100 is the maximum records per page this API allows.
LIMIT = 100

# How many records we want in total.
TARGET = 1000

# An informative user agent so the museum knows who is calling.
HEADERS = {
    "User-Agent": "STATS401-Class-Exercise/1.0 (educational use)"
}

# A polite delay between requests.
DELAY_SECONDS = 1


# ---------------------------------------------------------------------------
# Fetch one page from the API
# ---------------------------------------------------------------------------

def fetch_page(page_number):
    """Request one page of artworks and return the list of raw records."""

    params = {
        "page": page_number,
        "limit": LIMIT,
        "fields": FIELDS,
    }

    response = requests.get(
        BASE_URL,
        params=params,
        headers=HEADERS,
        timeout=10,
    )

    response.raise_for_status()

    # The API wraps the records in a "data" key.
    return response.json()["data"]


# ---------------------------------------------------------------------------
# Main loop (pagination + rate limiting + error handling)
# ---------------------------------------------------------------------------

def main():

    records = []
    page = 1

    while len(records) < TARGET:

        try:
            data = fetch_page(page)

        except requests.RequestException as error:
            # This page failed; report it, wait, and try the next one.
            print(f"Failed on page {page}: {error}")
            page += 1
            time.sleep(DELAY_SECONDS)
            continue

        # If the API returns an empty page, there is nothing left to collect.
        if not data:
            print("No more data returned; stopping early.")
            break

        for art in data:
            # .get() returns None if a field is missing (e.g. an unknown
            # artist). None becomes an empty cell in the CSV, which is fine.
            records.append({
                "id": art.get("id"),
                "title": art.get("title"),
                "artist": art.get("artist_title"),
                "year": art.get("date_start"),
                "type": art.get("artwork_type_title"),
                "department": art.get("department_title"),
            })

        print(f"Page {page:>2}: fetched {len(data)} artworks "
              f"(running total: {len(records)})")

        page += 1
        time.sleep(DELAY_SECONDS)

    # Trim to exactly TARGET in case the last page pushed us over.
    records = records[:TARGET]

    print(f"\nDone. Total records collected: {len(records)}")

    # -- Save to CSV --------------------------------------------------------
    df = pd.DataFrame(records)

    # Use a nullable integer type so years save as "1884" (not "1884.0")
    # while still allowing blanks for works whose year is unknown.
    df["year"] = df["year"].astype("Int64")

    # Build the output path relative to THIS script's location, not to
    # whatever folder you happen to run the command from. This means the
    # file always lands in stats401-labs/data/ no matter where you run it.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "..", "data")
    os.makedirs(data_dir, exist_ok=True)

    output_path = os.path.join(data_dir, "lab3_data.csv")
    df.to_csv(output_path, index=False)
    print(f"Saved {len(df)} records to {output_path}")


if __name__ == "__main__":
    main()