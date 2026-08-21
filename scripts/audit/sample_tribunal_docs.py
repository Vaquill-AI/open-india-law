"""Classify what tribunal PDFs actually contain, by uniform random sample.

The document count alone is misleading: a tribunal file may be a reasoned
decision, a one-line adjournment on an order sheet, or a case status printout.
This draws a uniform random sample per forum using reservoir sampling over a
full key listing, extracts the text, and classifies it.

At n=150 per forum the margin of error on a proportion is about 8 points at 95%
confidence, which is stated alongside the result rather than implied away.
"""
from __future__ import annotations
import boto3, io, json, random, collections, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from pypdf import PdfReader

REPO = Path(__file__).resolve().parents[2]
RAW = Path(__file__).parent / "raw"
N = 150
env = {}
for line in (REPO / ".env").read_text().splitlines():
    line = line.strip()
    if line.startswith("#") or "=" not in line: continue
    k, v = line.split("=", 1); env[k] = v.strip().strip('"').strip("'")

def s3c():
    return boto3.client("s3", endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=env["R2_ACCESS_KEY_ID"], aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        region_name="auto")

PREFIXES = ["pdfs/cat_cis/", "pdfs/drt/", "pdfs/cat/", "pdfs/itat/", "pdfs/cestat/",
            "pdfs/nclt/", "pdfs/ngt/", "pdfs/sat/", "pdfs/atfp/", "pdfs/cci/",
            "pdfs/aptel/", "pdfs/gst_aar/", "pdfs/ibbi/", "pdfs/tdsat/"]

def reservoir(s3, prefix, n=N):
    """Uniform random sample of n keys without holding the full listing."""
    rng = random.Random(4242)
    res, seen = [], 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket="tribunal-judgments", Prefix=prefix):
        for o in page.get("Contents", []):
            seen += 1
            if len(res) < n:
                res.append(o["Key"])
            else:
                j = rng.randrange(seen)
                if j < n: res[j] = o["Key"]
    return res, seen

def classify(txt: str) -> str:
    t = txt.upper(); n = len(txt.strip())
    if n == 0: return "no extractable text"
    if "CASE INFORMATION" in t and ("FILING NUMBER" in t or "CURRENT STATUS" in t):
        return "case status sheet"
    if "ORDER SHEET" in t and n < 1500: return "procedural order sheet"
    if n < 1200: return "short procedural order"
    if n < 4000: return "short order"
    return "substantive decision"

def fetch(key):
    try:
        raw = s3c().get_object(Bucket="tribunal-judgments", Key=key)["Body"].read()
        txt = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(raw)).pages)
        return classify(txt), len(txt.strip())
    except Exception:
        return "unreadable", 0

def main():
    s3 = s3c(); out = {"sample_size": N, "forums": {}}
    for pref in PREFIXES:
        t0 = time.time()
        keys, total = reservoir(s3, pref)
        with ThreadPoolExecutor(max_workers=12) as ex:
            res = list(ex.map(fetch, keys))
        cnt = collections.Counter(r[0] for r in res)
        chars = sorted(r[1] for r in res if r[1])
        n = sum(cnt.values())
        out["forums"][pref.split("/")[1]] = {
            "objects_in_prefix": total, "sampled": n,
            "median_text_chars": chars[len(chars) // 2] if chars else 0,
            "classes": dict(cnt),
            "pct": {k: round(100 * v / n, 1) for k, v in cnt.items()},
        }
        print(f"[{time.strftime('%H:%M:%S')}] {pref} total={total:,} n={n} "
              f"median_chars={out['forums'][pref.split('/')[1]]['median_text_chars']:,} "
              f"({round(time.time()-t0)}s)", flush=True)
        for k, v in cnt.most_common():
            print(f"      {k:24s} {v:4d}  {100*v/n:5.1f}%", flush=True)
        (RAW / "tribunal_doc_sample.json").write_text(json.dumps(out, indent=1))
    print("DONE")

if __name__ == "__main__":
    main()
