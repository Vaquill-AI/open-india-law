# Translation stack analysis (India era)

Written 2026-04-02 while evaluating the Indic translation stack for Anuvad.
These four files lived in `data/reference-repos/analysis/`, which was gitignored,
so they were never committed and existed in exactly one place on one laptop.

Preserved here on 2026-08-18 when the India-era corpora under `data/` were
deleted. The upstream repositories they analyze are all public and re-clonable:

- IndicTrans2: https://github.com/AI4Bharat/IndicTrans2.git
- IndicTransToolkit: https://github.com/VarunGumma/IndicTransToolkit.git
- Anuvaad: https://github.com/project-anuvaad/anuvaad.git
- ULCA: https://github.com/bhashini-dibd/ulca.git

Kept for the reasoning, not because the stack is still in use.

## Datasets deleted alongside these repos (2026-08-18)

All public and re-downloadable; none were ever committed.

- `data/datasets/` (4.45 GB): BPCC and Samanantar parallel corpora (AI4Bharat),
  plus `shabdavali_export*.json` from the Vidhi Shabdavali glossary build.
- `data/external-corpora/` (4.95 GB): Anuvaad corpus mirror and the Hindi legal
  term lists that fed the translation memory (`legal_terms_hi_clean.jsonl`).
- `data/Ultimate-Legal-Bundle-Vaquill.com/` (1.53 GB): English, Hindi, Gujarati,
  Marathi and Startup legal draft bundles, a product asset for the India market.
- `data/legal-glossary-govt/` (0.09 GB): hash-named Indian government glossary PDFs.
- `emails/` (0.25 GB): India-market outreach scrapers and contact data. Deleted
  primarily because the CSVs held personal data (name, email, phone, firm, city)
  for a market we exited. The 11 Markdown files in it are recoverable from git if
  the deliverability or spam-audit notes are ever wanted.
