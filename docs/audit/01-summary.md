# Summary: what we have and what we do not

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](02-methodology.md) for how each number is produced.

## Fix these two first

Both are bugs in data we already hold, not gaps in what we bought.
Neither needs a re-ingest.

**Every Supreme Court judgment is invisible to a date filter.**
Supreme Court points store `decision_date` as `DD-MM-YYYY`, which Qdrant's datetime index cannot parse, while High Court points use ISO format.
All 371,159 Supreme Court chunks are silently dropped by any date-scoped or recency-sorted query, with no error raised.

**The two case-law collections duplicate 436,622 judgments.**
`legal_corpus_v1` and `legal_corpus_v2` are searched together, and for most shared courts the v2 copy is a strict subset of v1.
That is embedding spend, storage and duplicate hits in retrieval for no added coverage.

Detail and exact per-court numbers in [case-law/data-quality.md](case-law/data-quality.md).

## The short version

1. We hold **12,848,644 Indian judgments** and **22,265 Indian statutory instruments**, embedded as **32,316,518 searchable chunks**.
2. Coverage is **High Courts and the Supreme Court only**, with no tribunal content whatsoever.
   The retrieval code already has tribunal handling built for data that does not exist, so that path is dead.
   See [case-law/tribunals.md](case-law/tribunals.md).
3. Case law spans **26 courts**, but volume is extremely uneven.
   The top five hold 7,208,329 cases, 56% of everything, while the bottom 4 courts hold under 25,000 each.
4. The **Supreme Court is 22nd largest of the 26 courts by volume**, with 34,954 judgments.
   It is the only court whose rulings bind nationally, and it is thinner than 21 of the High Courts we carry.
5. Practical data cutoff is **2025**.
   Latest decision date anywhere in the corpus is 2030-05-06, though some of the very latest dates are data errors rather than real judgments.

## Coverage by court, condensed

| Court | Cases | First | Last |
|---|---:|---|---|
| Patna High Court | 1,615,041 | 1924-12-15 | 2030-05-06 |
| Bombay High Court | 1,595,948 | 1908-07-28 | 2025-11-14 |
| Allahabad High Court | 1,498,250 | 1973-07-10 | 2025-12-17 |
| Madras High Court | 1,494,952 | 1976-03-26 | 2025-11-03 |
| Telangana High Court | 1,004,138 | 1963-06-28 | 2025-10-17 |
| Kerala High Court | 916,190 | 1950-02-07 | 2024-12-20 |
| Karnataka High Court | 581,276 | 1998-01-15 | 2025-09-26 |
| Chhattisgarh High Court | 508,791 | 1970-01-18 | 2025-10-13 |
| Punjab and Haryana High Court | 483,253 | 1989-12-20 | 2025-10-10 |
| Gujarat High Court | 411,638 | 1982-06-25 | 2025-10-06 |
| Madhya Pradesh High Court | 402,632 | 1994-05-16 | 2024-12-14 |
| Rajasthan High Court | 324,567 | 1989-03-31 | 2025-10-17 |
| Delhi High Court | 322,940 | 1960-10-10 | 2026-01-28 |
| Gauhati High Court | 285,714 | 1982-03-11 | 2029-04-05 |
| Orissa High Court | 283,063 | 1992-08-10 | 2025-10-24 |
| Andhra Pradesh High Court | 254,482 | 1995-09-18 | 2025-10-23 |
| Jharkhand High Court | 246,374 | 1993-01-01 | 2025-09-26 |
| Calcutta High Court | 202,565 | 1950-08-14 | 2025-11-27 |
| Himachal Pradesh High Court | 184,175 | 1970-11-25 | 2025-10-09 |
| Uttarakhand High Court | 123,853 | 1950-01-01 | 2025-10-17 |
| Jammu & Kashmir High Court | 40,289 | 2003-02-21 | 2025-10-18 |
| Supreme Court of India | 34,954 | 1950 (year only) | 2025 (year only) |
| Tripura High Court | 18,942 | 2013-01-04 | 2025-09-26 |
| Manipur High Court | 7,903 | 2017-05-19 | 2025-10-05 |
| Meghalaya High Court | 6,261 | 2010-07-06 | 2025-09-15 |
| Sikkim High Court | 453 | 2000-03-30 | 2025-09-23 |

## The 25 High Courts of India, checked one by one

India has 25 High Courts. This is which of them we carry.

| High Court | In corpus | Cases |
|---|---|---:|
| Allahabad High Court | yes | 1,498,250 |
| Andhra Pradesh High Court | yes | 254,482 |
| Bombay High Court | yes | 1,595,948 |
| Calcutta High Court | yes | 202,565 |
| Chhattisgarh High Court | yes | 508,791 |
| Delhi High Court | yes | 322,940 |
| Gauhati High Court | yes | 285,714 |
| Gujarat High Court | yes | 411,638 |
| Himachal Pradesh High Court | yes | 184,175 |
| Jammu & Kashmir High Court | yes | 40,289 |
| Jharkhand High Court | yes | 246,374 |
| Karnataka High Court | yes | 581,276 |
| Kerala High Court | yes | 916,190 |
| Madhya Pradesh High Court | yes | 402,632 |
| Madras High Court | yes | 1,494,952 |
| Manipur High Court | yes | 7,903 |
| Meghalaya High Court | yes | 6,261 |
| Orissa High Court | yes | 283,063 |
| Patna High Court | yes | 1,615,041 |
| Punjab and Haryana High Court | yes | 483,253 |
| Rajasthan High Court | yes | 324,567 |
| Sikkim High Court | yes | 453 |
| Telangana High Court | yes | 1,004,138 |
| Tripura High Court | yes | 18,942 |
| Uttarakhand High Court | yes | 123,853 |

All 25 High Courts are represented.

## Courts that are present but too thin to rely on

| Court | Cases | Earliest | Note |
|---|---:|---|---|
| Sikkim High Court | 453 | 2000-03-30 | first 2000, 25 years of data |
| Meghalaya High Court | 6,261 | 2010-07-06 | first 2010, 16 years of data |
| Manipur High Court | 7,903 | 2017-05-19 | first 2017, 9 years of data |
| Tripura High Court | 18,942 | 2013-01-04 | first 2013, 13 years of data |

## Where coverage starts, by court

Most courts have effectively nothing before the mid 2000s. A handful of very old entries exist but they are isolated, not continuous coverage. The column below is the first year in which a court has at least 1,000 cases, which is a far better guide to usable depth than the earliest date on record.

| Court | Earliest date | First year with 1,000+ cases | Years at 1,000+ |
|---|---|---:|---:|
| Patna High Court | 1924-12-15 | 2008 | 18 |
| Bombay High Court | 1908-07-28 | 2003 | 23 |
| Allahabad High Court | 1973-07-10 | 2018 | 8 |
| Madras High Court | 1976-03-26 | 2002 | 22 |
| Telangana High Court | 1963-06-28 | 2004 | 22 |
| Kerala High Court | 1950-02-07 | 2006 | 19 |
| Karnataka High Court | 1998-01-15 | 2012 | 14 |
| Chhattisgarh High Court | 1970-01-18 | 2003 | 23 |
| Punjab and Haryana High Court | 1989-12-20 | 2008 | 16 |
| Gujarat High Court | 1982-06-25 | 1996 | 25 |
| Madhya Pradesh High Court | 1994-05-16 | 2011 | 14 |
| Rajasthan High Court | 1989-03-31 | 2005 | 21 |
| Delhi High Court | 1960-10-10 | 2007 | 18 |
| Gauhati High Court | 1982-03-11 | 2007 | 19 |
| Orissa High Court | 1992-08-10 | 2013 | 12 |
| Andhra Pradesh High Court | 1995-09-18 | 2019 | 7 |
| Jharkhand High Court | 1993-01-01 | 2012 | 14 |
| Calcutta High Court | 1950-08-14 | 2020 | 6 |
| Himachal Pradesh High Court | 1970-11-25 | 2007 | 19 |
| Uttarakhand High Court | 1950-01-01 | 2003 | 23 |
| Jammu & Kashmir High Court | 2003-02-21 | 2017 | 9 |
| Supreme Court of India | 1950 (year only) | 1996 | 3 |
| Tripura High Court | 2013-01-04 | 2014 | 11 |
| Manipur High Court | 2017-05-19 | 2019 | 3 |
| Meghalaya High Court | 2010-07-06 | never | 0 |
| Sikkim High Court | 2000-03-30 | never | 0 |

## Legislation

- **22,265 instruments** across **1,098,577 individually embedded provisions**.
- **13,720 central instruments** and 8,545 state and territory instruments.
- **21,545 in force**, 710 repealed, 10 spent.
- 164,534 provisions carry no enactment year.

State-level legislation is thin and lopsided. See [legislation/by-state.md](legislation/by-state.md) for the full list.

## Known problems, ranked by how much they cost us

1. **2.1 million tribunal decision documents are held but not searchable.** 813,168 matters across 15 forums including NCLT, ITAT, CESTAT, CAT, NGT, DRT, SAT and CCI sit in storage as original PDF with no extracted text, so none of it can be retrieved, quoted or cited. For corporate, tax and insolvency work this is where most of the usable authority sits. See [tribunals/README.md](tribunals/README.md).
2. **Every Supreme Court judgment is invisible to a date filter**, because its `decision_date` is stored in a format the datetime index cannot parse.
3. **2,925 Supreme Court judgments have metadata but no vectors**, so they appear in browse yet cannot be retrieved, quoted or cited.
4. **The Supreme Court is under-covered overall**, at 34,954 judgments, and it is the only court whose authority binds nationally.
5. **436,622 judgments are duplicated across the two case-law collections**, which are searched together, so retrieval can return the same judgment twice.
6. **29 cases are unreachable by court filter** because their court label is a spelling the application does not know. See [case-law/court-name-variants.md](case-law/court-name-variants.md).
7. **Citations exist for the Supreme Court only.** Every High Court point in both collections has an empty `citation` field, so citation lookup silently fails for High Court authority.
8. **310,016 Supabase rows have no court**, and their parsed years run from 13 to 9916, which means the year was scraped out of citation text and often grabbed a volume number.
9. **Impossible future decision dates** reach browse ordering, which sorts by `decision_date DESC`. See [case-law/data-quality.md](case-law/data-quality.md).
10. **`jurisdiction` and `category` on `acts_india` are the same field**, and neither is a jurisdiction. See [legislation/data-quality.md](legislation/data-quality.md).
