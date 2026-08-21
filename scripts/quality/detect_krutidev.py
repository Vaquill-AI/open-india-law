"""
Detect Kruti Dev / legacy Hindi font gibberish in R2 corpus text.

Uses regex patterns specific to Kruti Dev font mapping artifacts.
Much more precise than generic gibberish detection.
"""

import asyncio
import csv
import random
import re
import sys
import time
from collections import Counter
from pathlib import Path

import httpx

R2_BASE = "${R2_PUBLIC_BASE_URL}/corpus-text"
CSV_PATH = Path(__file__).parent / "backfill_csv" / "legal_corpus_v2.csv"

# Kruti Dev specific patterns (Latin chars that represent Hindi)
KRUTI_PATTERNS = [
    re.compile(r"vk[oe]"),       # aa + vowel markers
    re.compile(r"fd;k"),         # kiya
    re.compile(r"/kkjk"),        # dhara
    re.compile(r"dk;Z"),         # karya
    re.compile(r"djus"),         # karne
    re.compile(r"djrk"),         # karta
    re.compile(r"tkrk"),         # jaata
    re.compile(r"gksxk"),        # hoga
    re.compile(r"U;k;"),         # nyay
    re.compile(r"dksbZ"),        # koi
    re.compile(r"vUrxZr"),       # antargat
    re.compile(r"fo}ku"),        # vidvan
    re.compile(r"iz[kls]"),      # pra- prefix
    re.compile(r"i=koyh"),       # patraavalee
    re.compile(r"vf/k"),         # adhi- prefix
    re.compile(r"\bgS\b"),       # hai
    re.compile(r"\bds\b"),       # ke
    re.compile(r"\bdks\b"),      # ko
    re.compile(r"\b;g\b"),       # yah
    re.compile(r"\besa\b"),      # mein
    re.compile(r"\brFkk\b"),     # tatha
    re.compile(r"kZ"),           # common Kruti suffix
    re.compile(r"Fkk"),          # tha
    re.compile(r"';"),           # sha-type marker
]

DEVANAGARI_RANGE = (0x0900, 0x097F)

ALL_COURTS = [
    "UPHC", "MPHC", "RJHC", "CGHC", "JHHC", "BRHC", "UKHC", "HPHC",
    "KLHC", "KAHC", "PHHC", "ODHC", "DLHC", "HCBM", "HCMA", "APHC",
    "GJHC", "HCMD", "GAHC", "MNHC", "MLHC", "JKHC", "HBHC",
]


def has_krutidev(text: str) -> bool:
    """Check if text contains Kruti Dev encoded Hindi."""
    # Check body (skip English header)
    body = text[300:5000] if len(text) > 500 else text
    if len(body) < 100:
        return False

    # Count Kruti Dev pattern matches
    matches = sum(len(p.findall(body)) for p in KRUTI_PATTERNS)
    words = len(body.split())
    if words == 0:
        return False

    score = matches / words
    # Threshold: >0.05 matches per word = Kruti Dev text
    return score > 0.05


def has_devanagari(text: str) -> bool:
    """Check if text has proper Unicode Devanagari."""
    sample = text[:5000]
    deva = sum(1 for c in sample if DEVANAGARI_RANGE[0] <= ord(c) <= DEVANAGARI_RANGE[1])
    return deva / max(len(sample), 1) > 0.10


def classify(text: str) -> str:
    if not text or len(text.strip()) < 100:
        return "too_short"
    if has_devanagari(text):
        return "hindi_unicode"
    if has_krutidev(text):
        return "krutidev_gibberish"
    return "english"


async def fetch_text(client: httpx.AsyncClient, case_id: str) -> tuple[str, str | None]:
    url = f"{R2_BASE}/hc/{case_id}.txt"
    try:
        resp = await client.get(url)
        if resp.status_code == 200 and len(resp.text.strip()) > 50:
            return (case_id, resp.text)
    except Exception:
        pass
    return (case_id, None)


async def check_sc(client: httpx.AsyncClient, sc_ids: list[str], sample_n: int) -> None:
    """Check SC cases separately."""
    sample = random.sample(sc_ids, min(len(sc_ids), sample_n))
    counts: Counter = Counter()
    examples: list[tuple[str, str]] = []

    for i in range(0, len(sample), 50):
        batch = sample[i:i+50]
        tasks = []
        for cid in batch:
            urls = [f"{R2_BASE}/sc/{cid}_EN.txt", f"{R2_BASE}/sc/{cid}.txt"]
            tasks.append(fetch_sc_text(client, cid, urls))
        results = await asyncio.gather(*tasks)
        for cid, text in results:
            if text is None:
                counts["no_text"] += 1
            else:
                cls = classify(text)
                counts[cls] += 1
                if cls == "krutidev_gibberish" and len(examples) < 3:
                    examples.append((cid, text[300:500]))

    total = sum(counts.values())
    pool = len(sc_ids)
    print(f"\nSC (sampled {total}/{pool:,}):")
    for cls, cnt in counts.most_common():
        pct = cnt / total * 100
        est = int(cnt / total * pool)
        print(f"  {cls:25s}: {cnt:4d} ({pct:5.1f}%)  ~{est:,} estimated")
    if examples:
        for cid, snip in examples[:1]:
            print(f"  Example: [{cid}] {snip[:150]}...")


async def fetch_sc_text(client: httpx.AsyncClient, case_id: str, urls: list[str]) -> tuple[str, str | None]:
    for url in urls:
        try:
            resp = await client.get(url)
            if resp.status_code == 200 and len(resp.text.strip()) > 50:
                return (case_id, resp.text)
        except Exception:
            pass
    return (case_id, None)


async def main(sample_per_court: int = 300) -> None:
    print(f"Loading case IDs from {CSV_PATH}...")

    courts: dict[str, list[str]] = {}
    sc_ids: list[str] = []

    with open(CSV_PATH) as f:
        for row in csv.DictReader(f):
            cid = row["corpus_case_id"]
            if cid[:4].isdigit() and len(cid) > 4 and cid[4] == "_":
                sc_ids.append(cid)
            else:
                prefix = cid[:4]
                if prefix not in courts:
                    courts[prefix] = []
                courts[prefix].append(cid)

    total_krutidev = 0
    total_hindi_unicode = 0
    total_checked = 0

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        print(f"\n{'='*70}")
        print("HIGH COURTS")
        print(f"{'='*70}")

        for court in ALL_COURTS:
            ids = courts.get(court, [])
            if not ids:
                continue

            n = min(len(ids), sample_per_court)
            sample = random.sample(ids, n)
            counts: Counter = Counter()
            examples: list[tuple[str, str]] = []

            for i in range(0, len(sample), 50):
                batch = sample[i:i+50]
                results = await asyncio.gather(*[fetch_text(client, cid) for cid in batch])
                for cid, text in results:
                    if text is None:
                        counts["no_text"] += 1
                    else:
                        cls = classify(text)
                        counts[cls] += 1
                        if cls == "krutidev_gibberish" and len(examples) < 3:
                            examples.append((cid, text[300:600]))

            total = sum(counts.values())
            pool = len(ids)
            gib = counts.get("krutidev_gibberish", 0)
            hindi = counts.get("hindi_unicode", 0)

            est_gib = int(gib / total * pool) if total else 0
            est_hindi = int(hindi / total * pool) if total else 0
            total_krutidev += est_gib
            total_hindi_unicode += est_hindi
            total_checked += pool

            # Only print if has gibberish or hindi
            if gib > 0 or hindi > 0:
                print(f"\n{court} (sampled {total}/{pool:,}):")
                for cls, cnt in counts.most_common():
                    pct = cnt / total * 100
                    est = int(cnt / total * pool)
                    print(f"  {cls:25s}: {cnt:4d} ({pct:5.1f}%)  ~{est:,} estimated")
                if examples:
                    for cid, snip in examples[:1]:
                        print(f"  Example: [{cid}] {snip[:150]}...")
            else:
                print(f"{court}: {total}/{pool:,} sampled, all English", end="  ")

        # SC
        print(f"\n\n{'='*70}")
        print("SUPREME COURT")
        print(f"{'='*70}")
        await check_sc(client, sc_ids, sample_per_court)

    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"  Kruti Dev gibberish: ~{total_krutidev:,} estimated across {total_checked:,} HC cases")
    print(f"  Hindi Unicode:       ~{total_hindi_unicode:,} estimated")
    print(f"  Gibberish rate:      {total_krutidev/max(total_checked,1)*100:.2f}%")


if __name__ == "__main__":
    sample = 300
    if "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample = int(sys.argv[idx + 1])
    asyncio.run(main(sample))
