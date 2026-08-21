"""
Detect gibberish/legacy-font-encoded text in R2 corpus text files.

Samples case IDs from the backfill CSV and checks their R2 text files for
legacy Hindi font encoding (Kruti Dev, Chanakya, etc.) that produces
Latin gibberish instead of proper Unicode Devanagari.

Detection heuristic:
- Text is mostly Latin/ASCII (no Devanagari Unicode)
- But has patterns typical of Kruti Dev mapped text:
  high frequency of rare-in-English chars, nonsensical bigrams,
  or a low ratio of common English words.

Usage:
    python scripts/detect_gibberish_text.py [--sample N] [--all]
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

# Common English words (top 50) for English detection
COMMON_EN_WORDS = {
    "the", "of", "and", "to", "in", "a", "is", "that", "for", "it",
    "was", "on", "are", "as", "with", "his", "they", "be", "at", "one",
    "have", "this", "from", "or", "had", "by", "not", "but", "what", "all",
    "were", "when", "we", "there", "can", "an", "your", "which", "their",
    "said", "if", "do", "will", "each", "about", "how", "up", "out", "them",
    "shall", "court", "case", "order", "section", "act", "petition",
    "respondent", "appellant", "petitioner", "applicant", "state",
}

# Unicode ranges
DEVANAGARI_RANGE = (0x0900, 0x097F)
LATIN_EXTENDED_RANGE = (0x00C0, 0x024F)  # Latin Extended-A/B


def is_devanagari(ch: str) -> bool:
    return DEVANAGARI_RANGE[0] <= ord(ch) <= DEVANAGARI_RANGE[1]


def is_latin_extended(ch: str) -> bool:
    return LATIN_EXTENDED_RANGE[0] <= ord(ch) <= LATIN_EXTENDED_RANGE[1]


def classify_text(text: str) -> str:
    """Classify text as 'english', 'hindi_unicode', 'gibberish', or 'mixed'.

    Returns:
        'english' - normal English text
        'hindi_unicode' - proper Devanagari Unicode
        'gibberish' - legacy font encoded (Latin chars representing Hindi)
        'mixed' - contains both English and Devanagari
        'empty' - no meaningful text
    """
    if not text or len(text.strip()) < 100:
        return "empty"

    sample = text[:5000]
    total = len(sample)

    devanagari_count = sum(1 for c in sample if is_devanagari(c))
    latin_ext_count = sum(1 for c in sample if is_latin_extended(c))
    ascii_count = sum(1 for c in sample if 32 <= ord(c) <= 126)

    devanagari_ratio = devanagari_count / total
    latin_ext_ratio = latin_ext_count / total

    # Clear Devanagari Unicode text
    if devanagari_ratio > 0.15:
        if ascii_count / total > 0.3:
            return "mixed"
        return "hindi_unicode"

    # Check if English by looking for common words
    words = sample.lower().split()
    if words:
        en_word_count = sum(1 for w in words[:200] if w.strip(".,;:()\"'") in COMMON_EN_WORDS)
        en_word_ratio = en_word_count / min(len(words), 200)

        # Normal English text has >10% common words
        if en_word_ratio > 0.08:
            return "english"

    # High Latin Extended ratio with low English words = gibberish (Kruti Dev)
    if latin_ext_ratio > 0.03:
        return "gibberish"

    # Low English word ratio and no Devanagari = likely gibberish
    # Kruti Dev uses ASCII range but produces nonsense English
    words_sample = sample.lower().split()
    if words_sample:
        en_ratio = sum(1 for w in words_sample[:200] if w.strip(".,;:()\"'") in COMMON_EN_WORDS) / min(len(words_sample), 200)
        if en_ratio < 0.03:
            return "gibberish"

    return "english"


async def fetch_text(client: httpx.AsyncClient, case_id: str, court_prefix: str) -> tuple[str, str | None]:
    """Fetch text from R2. Returns (case_id, text or None)."""
    if court_prefix == "sc":
        urls = [
            f"{R2_BASE}/sc/{case_id}_EN.txt",
            f"{R2_BASE}/sc/{case_id}.txt",
        ]
    else:
        urls = [f"{R2_BASE}/hc/{case_id}.txt"]

    for url in urls:
        try:
            resp = await client.get(url)
            if resp.status_code == 200 and len(resp.text.strip()) > 50:
                return (case_id, resp.text)
        except Exception:
            pass
    return (case_id, None)


def detect_court_prefix(case_id: str) -> str:
    if case_id and len(case_id) > 4 and case_id[:4].isdigit() and case_id[4] == "_":
        return "sc"
    return "hc"


async def sample_and_check(sample_size: int = 2000) -> None:
    """Sample case IDs from CSV and check their R2 text for gibberish."""

    print(f"Loading case IDs from {CSV_PATH}...")
    hc_ids: list[str] = []
    sc_ids: list[str] = []

    with open(CSV_PATH, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row["corpus_case_id"]
            if row.get("has_full_text") == "True":
                if detect_court_prefix(cid) == "sc":
                    sc_ids.append(cid)
                else:
                    hc_ids.append(cid)

    print(f"Total cases with full text: HC={len(hc_ids):,}, SC={len(sc_ids):,}")

    # Sample proportionally
    hc_sample_size = min(len(hc_ids), int(sample_size * 0.7))
    sc_sample_size = min(len(sc_ids), sample_size - hc_sample_size)

    hc_sample = random.sample(hc_ids, hc_sample_size)
    sc_sample = random.sample(sc_ids, sc_sample_size) if sc_ids else []

    all_samples = [(cid, detect_court_prefix(cid)) for cid in hc_sample + sc_sample]
    print(f"Sampling {len(all_samples)} cases (HC={len(hc_sample)}, SC={len(sc_sample)})...")

    # Fetch and classify in batches
    results: dict[str, Counter] = {"hc": Counter(), "sc": Counter()}
    gibberish_examples: list[tuple[str, str]] = []

    batch_size = 50
    start = time.time()

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for i in range(0, len(all_samples), batch_size):
            batch = all_samples[i : i + batch_size]
            tasks = [fetch_text(client, cid, prefix) for cid, prefix in batch]
            batch_results = await asyncio.gather(*tasks)

            for case_id, text in batch_results:
                prefix = detect_court_prefix(case_id)
                if text is None:
                    results[prefix]["no_text"] += 1
                else:
                    classification = classify_text(text)
                    results[prefix][classification] += 1
                    if classification == "gibberish" and len(gibberish_examples) < 10:
                        gibberish_examples.append((case_id, text[:300]))

            done = min(i + batch_size, len(all_samples))
            elapsed = time.time() - start
            rate = done / elapsed if elapsed > 0 else 0
            print(f"  Checked {done}/{len(all_samples)} ({rate:.0f}/s)", end="\r")

    elapsed = time.time() - start
    print(f"\n\nDone in {elapsed:.1f}s\n")

    # Print results
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)

    for prefix in ["hc", "sc"]:
        total_sampled = sum(results[prefix].values())
        if total_sampled == 0:
            continue
        total_pool = len(hc_ids) if prefix == "hc" else len(sc_ids)

        print(f"\n--- {prefix.upper()} (sampled {total_sampled}, total pool {total_pool:,}) ---")
        for classification, count in results[prefix].most_common():
            pct = count / total_sampled * 100
            estimated = int(count / total_sampled * total_pool)
            print(f"  {classification:20s}: {count:5d} ({pct:5.1f}%)  ~{estimated:,} estimated total")

    if gibberish_examples:
        print(f"\n{'=' * 60}")
        print("GIBBERISH EXAMPLES (first 300 chars)")
        print("=" * 60)
        for cid, snippet in gibberish_examples[:5]:
            print(f"\n[{cid}]")
            print(snippet[:200])
            print("...")


if __name__ == "__main__":
    sample = 2000
    if "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample = int(sys.argv[idx + 1])
    if "--all" in sys.argv:
        sample = 999999

    asyncio.run(sample_and_check(sample))
