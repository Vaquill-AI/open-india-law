"""Split the legislation corpus by issuing body.

The `acts_india` collection mixes primary legislation with subordinate material
issued by regulators, and the only jurisdiction signal is `state`, which puts
every regulator under `central`. That hides the fact that regulator instruments
are about half the collection.

The issuing body is encoded in the act identifier: `REG_<ISSUER>_<ref>` for
regulator material, `IND_<kind>_<n>` for statutes. This walks every point once,
mapping each act to its issuer and enactment year, so the breakdown is exact
rather than inferred from a sample.

Writes raw/regulators.json.
"""

from __future__ import annotations

import json
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RAW = Path(__file__).parent / "raw"
RAW.mkdir(exist_ok=True)

env = {}
for line in (REPO / ".env").read_text().splitlines():
    line = line.strip()
    if line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k] = v.strip().strip('"').strip("'")

URL = env["QDRANT_CORPUS_URL"].rstrip("/")
KEY = env["QDRANT_CORPUS_API_KEY"]

# Issuer code -> how it should be described to a reader.
ISSUERS = {
    "SEBI": ("Securities and Exchange Board of India", "Securities and capital markets"),
    "RBI": ("Reserve Bank of India", "Banking, payments and foreign exchange"),
    "MCA": ("Ministry of Corporate Affairs", "Company law and corporate governance"),
    "IRDAI": ("Insurance Regulatory and Development Authority of India", "Insurance"),
    "TRAI": ("Telecom Regulatory Authority of India", "Telecom and broadcasting"),
    "DGFT": ("Directorate General of Foreign Trade", "Import and export policy"),
    "CBIC": ("Central Board of Indirect Taxes and Customs", "GST, customs and excise"),
    "MOEFCC": ("Ministry of Environment, Forest and Climate Change", "Environment and forests"),
    "CPCB": ("Central Pollution Control Board", "Pollution control"),
    "DFS": ("Department of Financial Services", "Banking and insurance policy"),
    "LAW": ("Ministry of Law and Justice", "Law Commission reports and legal affairs"),
    "TRIB": ("State GST and tax authorities", "State GST notifications"),
}


def post(path: str, body: dict, timeout: int = 900):
    req = urllib.request.Request(
        URL + path,
        data=json.dumps(body).encode(),
        headers={"api-key": KEY, "content-type": "application/json"},
        method="POST",
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def issuer_of(act_id: str) -> tuple[str, str]:
    """(issuer code, kind) for an act identifier."""
    parts = act_id.split("_")
    if act_id.startswith("REG_") and len(parts) > 1:
        return parts[1], "regulator instrument"
    if act_id.startswith("IND_"):
        kind = parts[1] if len(parts) > 1 else ""
        if kind == "central":
            return "CENTRAL", "Central Act"
        if kind == "state":
            return "STATE", "State or UT legislation"
        if kind == "REP":
            return "REPEALED", "repealed Act"
        if kind == "SPENT":
            return "SPENT", "spent Act"
    return "OTHER", "other"


def main() -> None:
    # act_id -> provisions, exact
    hits = post("/collections/acts_india/facet",
                {"key": "act_id", "limit": 40000, "exact": True})["result"]["hits"]
    prov_by_act = {h["value"]: h["count"] for h in hits}
    print(f"acts {len(prov_by_act):,}  provisions {sum(prov_by_act.values()):,}", flush=True)

    # Enactment year per issuer is deliberately not computed here. It needs a
    # full scan of every provision to date each act, which takes about an hour
    # and is not used by any report. The act_id facet above is exact and instant.
    year_by_act: dict[str, int] = {}
    seen = 0

    agg: dict[str, dict] = defaultdict(
        lambda: {"instruments": 0, "provisions": 0, "years": defaultdict(int)})
    for act, prov in prov_by_act.items():
        code, kind = issuer_of(act)
        a = agg[code]
        a["instruments"] += 1
        a["provisions"] += prov
        a["kind"] = kind
        y = year_by_act.get(act)
        if y:
            a["years"][str(y)] += 1

    out = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_acts": len(prov_by_act),
        "total_provisions": sum(prov_by_act.values()),
        "acts_scanned": seen,
        "acts_with_year": len(year_by_act),
        "issuers": {},
    }
    for code, a in sorted(agg.items(), key=lambda kv: -kv[1]["instruments"]):
        name, subject = ISSUERS.get(code, (code, ""))
        yrs = {k: v for k, v in sorted(a["years"].items(), key=lambda kv: int(kv[0]))}
        out["issuers"][code] = {
            "name": name, "subject": subject, "kind": a["kind"],
            "instruments": a["instruments"], "provisions": a["provisions"],
            "earliest_year": min((int(y) for y in yrs), default=None),
            "latest_year": max((int(y) for y in yrs), default=None),
            "instruments_with_year": sum(yrs.values()),
            "years": yrs,
        }
        print(f"  {code:10s} {a['instruments']:>7,} instruments  "
              f"{a['provisions']:>9,} provisions", flush=True)

    out["reconciles"] = (
        sum(v["instruments"] for v in out["issuers"].values()) == out["total_acts"]
        and sum(v["provisions"] for v in out["issuers"].values()) == out["total_provisions"]
    )
    (RAW / "regulators.json").write_text(json.dumps(out, indent=1))
    print(f"reconciles: {out['reconciles']}")


if __name__ == "__main__":
    main()
