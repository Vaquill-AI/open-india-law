#!/usr/bin/env python3
"""
Export Qdrant corpus metadata to CSV. Designed to run ON the Qdrant server
for zero-latency localhost scroll. No Supabase dependency.

Usage (on Qdrant server):
    python3 export_qdrant_csv.py --collection v2
    python3 export_qdrant_csv.py --collection v1
    python3 export_qdrant_csv.py  # both

Output: /tmp/legal_corpus_v2.csv, /tmp/legal_corpus_v1.csv
"""

import argparse
import csv
import json
import re
import sys
import time

import requests

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "")  # pragma: allowlist secret
HEADERS = {"api-key": QDRANT_API_KEY, "Content-Type": "application/json"}

COLLECTIONS = {"v1": "legal_corpus_v1", "v2": "legal_corpus_v2"}
BATCH_SIZE = 5000  # Large batches OK on localhost

PAYLOAD_FIELDS = [
    "case_id", "title", "court", "court_type", "disposition",
    "petitioner", "respondent", "bench_strength", "judges",
    "total_chunks", "pdf_url", "year", "decision_date",
    "case_number", "citation",
]

CSV_FIELDS = [
    "corpus_case_id", "case_name", "court", "court_type", "court_normalized",
    "year", "primary_citation", "normalized_citation", "decision_date",
    "disposition", "disposition_normalized", "petitioner", "respondent",
    "bench_strength", "judges", "snippet", "total_chunks", "r2_url",
    "source_type", "has_full_text",
]

# Court name normalization
COURT_VARIANTS = {
    "Allahabad High Court": ["High Court of Allahabad"],
    "Andhra Pradesh High Court": ["High Court of Andhra Pradesh", "High Court of Amaravati"],
    "Bombay High Court": ["High Court of Bombay"],
    "Calcutta High Court": ["High Court of Calcutta"],
    "Chhattisgarh High Court": ["High Court Of Chhattisgarh", "High Court of Chhattisgarh"],
    "Delhi High Court": ["High Court of Delhi"],
    "Gauhati High Court": ["High Court of Gauhati"],
    "Gujarat High Court": ["High Court of Gujarat"],
    "Himachal Pradesh High Court": ["High Court of Himachal Pradesh"],
    "Jammu & Kashmir High Court": ["High Court of Jammu and Kashmir", "Jammu and Kashmir High Court"],
    "Jharkhand High Court": ["High Court of Jharkhand"],
    "Karnataka High Court": ["High Court of Karnataka"],
    "Kerala High Court": ["High Court of Kerala"],
    "Madhya Pradesh High Court": ["High Court of Madhya Pradesh"],
    "Madras High Court": ["High Court of Madras"],
    "Manipur High Court": ["High Court of Manipur"],
    "Meghalaya High Court": ["High Court of Meghalaya"],
    "Orissa High Court": ["High Court of Orissa", "Orissa High Court"],
    "Patna High Court": ["High Court of Patna"],
    "Punjab and Haryana High Court": ["High Court of Punjab and Haryana", "High Court of Haryana"],
    "Rajasthan High Court": ["High Court Of Rajasthan", "High Court of Rajasthan"],
    "Sikkim High Court": ["High Court of Sikkim"],
    "Telangana High Court": ["High Court  for State of Telangana", "High Court of Telangana", "High Court of Hyderabad"],
    "Tripura High Court": ["High Court of Tripura"],
    "Uttarakhand High Court": ["High Court of Uttarakhand"],
}
REVERSE_COURT = {}
for canon, variants in COURT_VARIANTS.items():
    REVERSE_COURT[canon] = canon
    for v in variants:
        REVERSE_COURT[v] = canon
REVERSE_COURT["Supreme Court of India"] = "Supreme Court of India"

DISPOSITION_MAP = {
    "Allowed": "ALLOWED", "ALLOWED": "ALLOWED", "allowed": "ALLOWED",
    "Dismissed": "DISMISSED", "DISMISSED": "DISMISSED", "dismissed": "DISMISSED",
    "Disposed Off": "DISPOSED OF", "DISPOSED OFF": "DISPOSED OF", "DISPOSED": "DISPOSED OF",
    "Disposed Of": "DISPOSED OF", "Disposed": "DISPOSED OF", "DISPOSED OF": "DISPOSED OF",
    "Partly Allowed": "PARTLY ALLOWED", "PARTLY ALLOWED": "PARTLY ALLOWED",
    "Rejected": "REJECTED", "REJECTED": "REJECTED",
    "Bail": "BAIL GRANTED", "BAIL": "BAIL GRANTED", "Bail Granted": "BAIL GRANTED",
}


def transform(payload):
    case_id = payload.get("case_id")
    if not case_id:
        return None

    title = payload.get("title")
    court = payload.get("court")
    court_normalized = REVERSE_COURT.get(court, court)
    court_type = payload.get("court_type")
    if not court_type and court_normalized:
        court_type = "supreme_court" if "Supreme" in court_normalized else "high_court"

    disposition = payload.get("disposition")
    disposition_normalized = DISPOSITION_MAP.get(disposition)

    judges = payload.get("judges")
    bench_strength = payload.get("bench_strength")
    if (not bench_strength or bench_strength == 0) and isinstance(judges, list):
        bench_strength = len(judges)

    year = payload.get("year")
    decision_date = payload.get("decision_date")
    if decision_date:
        decision_date = str(decision_date).split(" ")[0]
        parts = decision_date.split("-")
        if len(parts) == 3 and len(parts[2]) == 4:
            decision_date = f"{parts[2]}-{parts[1]}-{parts[0]}"

    citation = payload.get("citation")
    primary_citation = citation if citation else f"HC-{case_id}"

    snippet_parts = [p for p in [title, payload.get("petitioner"), payload.get("respondent")] if p]
    snippet = " | ".join(snippet_parts)[:200].strip() if snippet_parts else None

    record = {
        "corpus_case_id": case_id,
        "case_name": title,
        "court": court,
        "court_type": court_type,
        "court_normalized": court_normalized,
        "year": year,
        "primary_citation": primary_citation,
        "normalized_citation": primary_citation,
        "decision_date": decision_date if decision_date else None,
        "disposition": disposition,
        "disposition_normalized": disposition_normalized,
        "petitioner": payload.get("petitioner"),
        "respondent": payload.get("respondent"),
        "bench_strength": bench_strength if bench_strength and bench_strength > 0 else None,
        "judges": json.dumps(judges) if isinstance(judges, list) and judges else None,
        "snippet": snippet,
        "total_chunks": payload.get("total_chunks"),
        "r2_url": payload.get("pdf_url"),
        "source_type": "CORPUS",
        "has_full_text": True,
    }
    return {k: v for k, v in record.items() if v is not None}


def scroll_collection(collection, output_path):
    # Count
    resp = requests.post(
        f"{QDRANT_URL}/collections/{collection}/points/count",
        headers=HEADERS, timeout=60,
        json={"exact": False, "filter": {"must": [{"key": "chunk_index", "match": {"value": 0}}]}},
    )
    total = resp.json()["result"]["count"]
    print(f"{collection}: ~{total:,} cases -> {output_path}", flush=True)

    offset = None
    batch_num = 0
    written = 0
    start = time.time()

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()

        while True:
            body = {
                "filter": {"must": [{"key": "chunk_index", "match": {"value": 0}}]},
                "limit": BATCH_SIZE,
                "with_payload": {"include": PAYLOAD_FIELDS},
                "with_vector": False,
            }
            if offset is not None:
                body["offset"] = offset

            for attempt in range(5):
                try:
                    resp = requests.post(
                        f"{QDRANT_URL}/collections/{collection}/points/scroll",
                        headers=HEADERS, timeout=120, json=body,
                    )
                    resp.raise_for_status()
                    break
                except Exception as e:
                    if attempt < 4:
                        print(f"  Scroll error (attempt {attempt+1}): {e}. Retrying...", flush=True)
                        time.sleep(2 * (attempt + 1))
                    else:
                        raise

            data = resp.json()["result"]
            points = data.get("points", [])
            if not points:
                break

            batch_num += 1
            for pt in points:
                record = transform(pt.get("payload", {}))
                if record:
                    writer.writerow(record)
                    written += 1

            offset = data.get("next_page_offset")
            if offset is None:
                break

            if batch_num % 10 == 0:
                elapsed = time.time() - start
                rate = written / elapsed if elapsed > 0 else 0
                pct = written / total * 100 if total > 0 else 0
                eta = (total - written) / rate / 60 if rate > 0 else 0
                print(f"  batch {batch_num} | {written:,} ({pct:.1f}%) | {rate:.0f}/sec | ETA: {eta:.0f}m", flush=True)
                f.flush()

    elapsed = time.time() - start
    import os
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    rate = written / elapsed if elapsed > 0 else 0
    print(f"  DONE: {written:,} rows | {size_mb:.0f} MB | {elapsed:.0f}s ({elapsed/60:.1f}m) | {rate:.0f}/sec", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--collection", choices=["v1", "v2"], default=None)
    args = parser.parse_args()

    collections = [COLLECTIONS[args.collection]] if args.collection else list(COLLECTIONS.values())

    for coll in collections:
        output = f"/tmp/{coll}.csv"
        scroll_collection(coll, output)


if __name__ == "__main__":
    main()
