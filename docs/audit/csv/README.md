# Spreadsheet pack

Generated 2026-07-28 by `scripts/audit/build_csvs.py` from the same extraction dumps as the rest of this folder, so these files and the markdown report cannot disagree.

Sixteen CSVs plus an index, sized and shaped for Google Sheets.
Every number is an exact full-collection count.
See [../02-methodology.md](../02-methodology.md) for how they were produced.

## Getting them into Google Sheets

Drag it into Google Drive, then open it and pick `File > Save as Google Sheets`.
Every tab arrives with a frozen, filterable header row.

The individual CSVs below are for scripting, diffing and version control.
If you do want them in Sheets separately, use `File > Import > Upload` and choose **Insert new sheet** per file.

Rebuild the workbook after changing any CSV:

```bash
uv run --with openpyxl python scripts/audit/build_workbook.py
```

Formatting notes that matter for charting:

- Numbers are raw integers with no thousands separators, so Sheets reads them as numbers rather than text.
- Dates are ISO `YYYY-MM-DD`.
- An empty cell means genuinely absent, never zero. In a chart, set `Insert > Chart > Setup > Plot null values` off so gaps stay gaps.
- Files ending `_long` are tidy: one observation per row. Use those for pivot tables.
- Files with `matrix` in the name are already pivoted, one row per year. Use those to chart a time axis directly.

## The files

| File | What it is |
|---|---|
| `00_index.csv` | this table, machine-readable, with a suggested chart per file |
| `01_summary_metrics.csv` | every headline number, one metric per row |
| `10_courts.csv` | one row per court: volume, span, depth, Supabase comparison |
| `11_court_year_long.csv` | tidy court by year. **Start here.** |
| `12_court_year_matrix_cases.csv` | wide: rows are years, columns are courts, values are cases |
| `13_court_year_matrix_chunks.csv` | same shape, values are embedded chunks |
| `14_court_raw_labels.csv` | every raw court string in Qdrant and what it resolves to |
| `15_collection_overlap.csv` | exact duplication between the two case-law collections |
| `16_qdrant_vs_supabase.csv` | searchable vectors against the metadata mirror, per court |
| `20_legislation_states.csv` | one row per state or territory |
| `21_legislation_state_year_long.csv` | tidy state by enactment year |
| `22_legislation_year.csv` | enactment year profile with the category split |
| `23_legislation_dimensions.csv` | subject, status, category and provision type, stacked |
| `30_data_quality.csv` | every defect found, with how many records it affects |
| `31_missing_fields.csv` | payload completeness per field |
| `32_case_law_distributions.csv` | section type, court type and disposition value counts |
| `33_supabase_unattributed.csv` | the Supabase rows that carry no court |

## One thing to watch

The per-year files (`11`, `12`, `13`) count a judgment held in **both** Qdrant collections twice.
That is why the `cases_pre_dedup` column is named the way it is.

Cross-collection duplication is only measurable per court, not per year, so:

- for a **total**, use `10_courts.csv` or `01_summary_metrics.csv`, which are deduplicated
- for a **shape over time**, use the per-year files, which are correct in trend but 3.4% high in level

The exact gap is 436,622 judgments, broken out per court in `15_collection_overlap.csv`.

| Figure | Value |
|---|---:|
| Judgments, deduplicated | 12,848,644 |
| Judgments, before dedup (what the per-year files sum to) | 13,285,266 |
| Difference | 436,622 |

## Charts worth building first

1. **Coverage over time.** `12_court_year_matrix_cases.csv`, stacked area, year on the x axis. Shows how little exists before roughly 2004.
2. **Volume by court.** `10_courts.csv`, bar chart of `cases`, sorted descending. Shows the top five holding 56% of everything.
3. **Where retrieval is blind.** `16_qdrant_vs_supabase.csv`, bar chart of `delta`, sorted ascending. The Supreme Court is the only meaningfully negative bar.
4. **Wasted duplication.** `15_collection_overlap.csv`, bar chart of `cases_in_both`.
5. **Depth versus breadth.** `10_courts.csv`, scatter with `years_covered` on x and `cases` on y. Separates courts with long thin tails from courts with short dense runs.
6. **Legislation skew.** `20_legislation_states.csv`, bar chart of `instruments`, with Central filtered out.
