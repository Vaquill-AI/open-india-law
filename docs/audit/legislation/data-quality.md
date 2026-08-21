# Legislation data quality

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

## `jurisdiction` and `category` are the same field

Both fields carry byte-identical value distributions across all 1,098,577 points: **yes**.

| Value | Provisions |
|---|---:|
| `regulatory` | 554,354 |
| `state` | 469,714 |
| `central` | 59,616 |
| `repealed` | 14,609 |
| `spent` | 284 |

Neither field is a jurisdiction. The values mix a jurisdiction axis (`central`, `state`), a document-kind axis (`regulatory`) and a status axis (`repealed`, `spent`).
A repealed *state* act is tagged `repealed`, which erases the fact that it is a state act. The only reliable jurisdiction signal is the separate `state` field.

Consequence: any filter of the form `jurisdiction = central` under-counts, because a central act that happens to be repealed lands in the `repealed` bucket instead.

## Missing values

| Field | Provisions with no value | Share |
|---|---:|---:|
| `acts_referenced` | 802,781 | 73.1% |
| `year` | 164,534 | 15.0% |
| `title` | 0 | 0.0% |
| `state` | 0 | 0.0% |
| `chapter` | 0 | 0.0% |
| `section_number` | 0 | 0.0% |

`year` is absent on 164,534 provisions (15.0%), so any date-scoped legislation query silently drops them.
`acts_referenced` is empty on 802,781 provisions, so cross-act citation traversal only works for a minority of the corpus.

## Fields that are indexed but never populated

These have a payload index built and maintained on every write, and zero points carrying a value. The index cost is paid for nothing.

| Field |
|---|
| `regulatory_body` |

## Enactment years that cannot be real

None. Every year in the collection falls in a plausible range.
