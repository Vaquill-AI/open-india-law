"""
Detect gibberish/legacy-font Hindi text in R2 corpus files.

Focuses on courts that commonly issue Hindi judgments:
UPHC (Allahabad), MPHC, RJHC, CGHC, JHHC, BRHC, UKHC, HPHC

Detection: Skip the English header, check the body for legacy font patterns.
Legacy Hindi fonts (Kruti Dev, Chanakya) produce Latin chars that look like:
  "orZeku nkf.Md izdh.kZ vfxze tekur" instead of proper Devanagari.

Heuristic for body text:
  1. Skip first 500 chars (usually English metadata header)
  2. Sample next 3000 chars
  3. If <5% common English words AND <5% Devanagari Unicode = gibberish
"""

import asyncio
import csv
import random
import sys
import time
from collections import Counter
from pathlib import Path

import httpx

R2_BASE = "${R2_PUBLIC_BASE_URL}/corpus-text"
CSV_PATH = Path(__file__).parent / "backfill_csv" / "legal_corpus_v2.csv"

COMMON_EN_WORDS = {
    "the", "of", "and", "to", "in", "a", "is", "that", "for", "it",
    "was", "on", "are", "as", "with", "his", "they", "be", "at", "one",
    "have", "this", "from", "or", "had", "by", "not", "but", "what", "all",
    "were", "when", "we", "there", "can", "an", "your", "which", "their",
    "said", "if", "do", "will", "each", "about", "how", "up", "out", "them",
    "shall", "court", "case", "order", "section", "act", "petition",
    "respondent", "appellant", "petitioner", "applicant", "state",
    "judgment", "evidence", "accused", "offence", "prosecution", "witness",
    "trial", "conviction", "sentence", "appeal", "revision", "bail",
    "matter", "prayer", "learned", "counsel", "argued", "submitted",
    "consideration", "facts", "circumstances", "disposed", "allowed",
    "dismissed", "rejected", "granted", "directed", "observed",
}

DEVANAGARI_RANGE = (0x0900, 0x097F)

# Hindi court prefixes
HINDI_COURTS = ["UPHC", "MPHC", "RJHC", "CGHC", "JHHC", "BRHC", "UKHC", "HPHC"]
# Other courts (mostly English)
OTHER_COURTS = ["KLHC", "KAHC", "PHHC", "ODHC", "DLHC", "HCBM", "HCMA", "APHC", "GJHC"]


def classify_body(text: str) -> str:
    """Classify the BODY of a judgment (skip header)."""
    if not text or len(text.strip()) < 200:
        return "too_short"

    # Skip header (first ~500 chars typically contain English metadata)
    body = text[500:4000]
    if len(body) < 100:
        body = text[200:]

    total_chars = len(body)
    if total_chars < 50:
        return "too_short"

    # Count Devanagari Unicode chars
    devanagari = sum(1 for c in body if DEVANAGARI_RANGE[0] <= ord(c) <= DEVANAGARI_RANGE[1])
    devanagari_ratio = devanagari / total_chars

    if devanagari_ratio > 0.15:
        return "hindi_unicode"

    # Count common English words
    words = body.lower().split()
    if not words:
        return "too_short"

    en_hits = sum(1 for w in words if w.strip(".,;:()\"'-/*#[]{}") in COMMON_EN_WORDS)
    en_ratio = en_hits / len(words)

    if en_ratio > 0.06:
        return "english"

    # Neither English nor Devanagari = gibberish (legacy font)
    return "gibberish"


async def fetch_text(client: httpx.AsyncClient, case_id: str) -> tuple[str, str | None]:
    url = f"{R2_BASE}/hc/{case_id}.txt"
    try:
        resp = await client.get(url)
        if resp.status_code == 200 and len(resp.text.strip()) > 50:
            return (case_id, resp.text)
    except Exception:
        pass
    return (case_id, None)


async def main(sample_per_court: int = 200) -> None:
    print(f"Loading case IDs from {CSV_PATH}...")

    courts: dict[str, list[str]] = {}
    with open(CSV_PATH) as f:
        for row in csv.DictReader(f):
            cid = row["corpus_case_id"]
            prefix = cid[:4]
            if prefix not in courts:
                courts[prefix] = []
            courts[prefix].append(cid)

    # Check Hindi courts
    print(f"\n{'='*70}")
    print("HINDI-LIKELY COURTS")
    print(f"{'='*70}")

    all_results: dict[str, dict[str, int]] = {}

    for court_prefix in HINDI_COURTS + OTHER_COURTS[:3]:
        ids = courts.get(court_prefix, [])
        if not ids:
            continue

        n = min(len(ids), sample_per_court)
        sample = random.sample(ids, n)

        counts: Counter = Counter()
        gibberish_examples: list[tuple[str, str]] = []

        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            for i in range(0, len(sample), 50):
                batch = sample[i:i+50]
                results = await asyncio.gather(*[fetch_text(client, cid) for cid in batch])
                for cid, text in results:
                    if text is None:
                        counts["no_text"] += 1
                    else:
                        cls = classify_body(text)
                        counts[cls] += 1
                        if cls == "gibberish" and len(gibberish_examples) < 3:
                            gibberish_examples.append((cid, text[500:700]))

        total_pool = len(ids)
        total_sampled = sum(counts.values())

        print(f"\n{court_prefix} (sampled {total_sampled}/{total_pool:,}):")
        for cls, cnt in counts.most_common():
            pct = cnt / total_sampled * 100
            est = int(cnt / total_sampled * total_pool)
            print(f"  {cls:20s}: {cnt:4d} ({pct:5.1f}%)  ~{est:,} estimated")

        if gibberish_examples:
            print(f"  Example gibberish:")
            for cid, snippet in gibberish_examples[:1]:
                print(f"    [{cid}] {snippet[:150]}...")

        all_results[court_prefix] = dict(counts)

    # Summary
    print(f"\n{'='*70}")
    print("SUMMARY ESTIMATES")
    print(f"{'='*70}")

    total_gibberish = 0
    total_cases = 0
    for court_prefix, counts in all_results.items():
        pool = len(courts.get(court_prefix, []))
        sampled = sum(counts.values())
        if sampled == 0:
            continue
        gib = counts.get("gibberish", 0)
        est_gib = int(gib / sampled * pool)
        total_gibberish += est_gib
        total_cases += pool
        if est_gib > 0:
            print(f"  {court_prefix}: ~{est_gib:,} gibberish out of {pool:,}")

    print(f"\n  TOTAL ESTIMATED GIBBERISH: ~{total_gibberish:,} out of {total_cases:,} sampled courts")


if __name__ == "__main__":
    sample = 200
    if "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample = int(sys.argv[idx + 1])

    asyncio.run(main(sample))
