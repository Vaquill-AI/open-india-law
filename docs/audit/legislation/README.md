# India legislation (acts and rules)

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

## What is here

One Qdrant collection, `acts_india`, holding **22,265 distinct instruments** split into **1,098,577 provisions** (sections, rules and regulations), each separately embedded.

| Metric | Value |
|---|---:|
| Distinct `act_id` values | 22,265 |
| Provision chunks (points) | 1,098,577 |
| State and territory buckets | 37 |
| Provisions with no year | 164,534 |
| Languages | en |

## Status

| Status | Instruments | Provisions |
|---|---:|---:|
| `in_force` | 21,545 | 1,083,684 |
| `repealed` | 710 | 14,609 |
| `spent` | 10 | 284 |

## Category

This is the `jurisdiction` field, which is also duplicated verbatim as `category`. Note that it mixes a real jurisdiction axis (central versus state) with a status axis (repealed, spent), so it cannot be used as a clean jurisdiction filter. See [data-quality.md](data-quality.md).

| Value | Instruments | Provisions |
|---|---:|---:|
| `regulatory` | 12,152 | 554,354 |
| `state` | 8,545 | 469,714 |
| `central` | 848 | 59,616 |
| `repealed` | 710 | 14,609 |
| `spent` | 10 | 284 |

## Subject

| Legal subject | Instruments | Provisions |
|---|---:|---:|
| `general` | 13,400 | 597,478 |
| `administrative_law` | 2,387 | 174,629 |
| `tax_law` | 1,991 | 162,441 |
| `banking_finance` | 1,920 | 98,306 |
| `corporate_law` | 1,669 | 92,262 |
| `property_law` | 1,451 | 56,533 |
| `environmental_law` | 665 | 35,063 |
| `labour_law` | 389 | 16,550 |
| `criminal_law` | 323 | 23,856 |
| `constitutional_law` | 229 | 4,000 |
| `family_law` | 223 | 10,220 |
| `civil_procedure` | 191 | 9,313 |
| `information_technology` | 79 | 2,832 |
| `intellectual_property` | 40 | 1,293 |

## Also in this folder

- [by-state.md](by-state.md) every state and territory, with its own year profile
- [by-year.md](by-year.md) enactment year across the whole collection
- [data-quality.md](data-quality.md) schema and coverage problems found in this audit
