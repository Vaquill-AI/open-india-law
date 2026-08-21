# Licensing

Indian primary law is **not** public domain the way US law is, so this file does not mirror the licensing of our US corpus.
Read it before you rely on anything here.

## The underlying legal text: Government work, reproducible by statute

Under **section 2(k)** of the Copyright Act 1957, a "Government work" includes a work made or published by or under the direction or control of the Government, any Legislature in India, **or any court, tribunal or other judicial authority in India**.
Under **section 17(d)**, the Government is the first owner of the copyright in a Government work.

So Indian statutes, judgments and tribunal orders **are** subject to copyright, and that copyright belongs to the Government.
India has no equivalent of the US government-edicts doctrine (*Georgia v. Public.Resource.Org*, 590 U.S. 255 (2020)).

Reproduction is nonetheless lawful, because **section 52(1)(q)** declares it non-infringing:

> (q) the reproduction or publication of -
> (i) any matter which has been published in any Official Gazette except an Act of a Legislature;
> (ii) any Act of a Legislature subject to the condition that such Act is reproduced or published together with any commentary thereon or any other original matter;
> (iii) the report of any committee, commission, council, board or other like body appointed by the Legislature, unless the reproduction or publication of such report is prohibited by the Government;
> (iv) any judgment or order of a court, Tribunal or other judicial authority, unless the reproduction or publication of such judgment or order is prohibited by the court, the Tribunal or other judicial authority, as the case may be.

Two consequences we take seriously:

1. **We are not the copyright owner of the legal text and therefore cannot license it to you.**
   We claim no rights in it and grant none.
   Your right to use it comes from section 52(1)(q), not from us.
2. **The section 52(1)(q)(iv) exemption is defeasible.**
   Where a court has prohibited publication, sealed a matter, or heard it in camera, the exemption does not apply by its own terms.
   Documents reciting such a direction are excluded from this corpus.

Section 52(1)(q)(ii) also attaches a condition to legislation: an Act is exempt when reproduced "together with any commentary thereon or any other original matter."
The section-level structure, hierarchy, stable identifiers, cross-references, amendment history and status classification this project adds are intended to satisfy that condition.
A byte-for-byte copy of a bare Act, on its own, likely would not.

## Our compilation: CC BY 4.0

The **compilation, structuring, normalization, hierarchy, stable identifiers, breadcrumbs, source-URL mapping, status classification and other metadata** that this project adds on top of the legal text are licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**.

You are free to:

- **Share** - copy and redistribute the material in any medium or format.
- **Adapt** - remix, transform, and build upon the material for any purpose, including commercially.

Under the following term:

- **Attribution** - You must give appropriate credit, provide a link to the license, and indicate if changes were made.
  You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.

Full license text: https://creativecommons.org/licenses/by/4.0/legalcode
Human-readable summary: https://creativecommons.org/licenses/by/4.0/

### Suggested attribution

> Structured Indian primary-law data from the Open India Law corpus by Vaquill AI
> (https://github.com/Vaquill-AI/open-india-law), used under CC BY 4.0.

## Why not CC0

Two reasons, and they are both binding rather than stylistic.

First, we cannot waive rights in the underlying text, because we do not hold them (see above).

Second, our sources require attribution as a condition of reuse.
The eCourts and eSCR copyright policy permits reproduction only where the source is "duly and prominently acknowledged."
The NCLT and NCLAT copyright policies permit free reproduction "without requiring specific permission" but require that "the source must be prominently acknowledged."
A CC0 dedication would purport to release downstream users from a condition our sources actually impose.

## Attribution to the sources themselves

Redistribution of this corpus must preserve acknowledgement of the originating publisher.
Per-record `source_url` and `source_publisher` fields carry that information, and the dataset card lists the publisher for each corpus.

## Not covered by the Government Open Data License (GODL-India)

We do not rely on GODL-India.
Its section 6 excludes "Personal Information" from the licence grant, defined broadly enough to cover material in judicial records, and its section 7(c) reserves a unilateral right to require "immediate retraction of the data set concerned from public access."
Section 52(1)(q) is a stronger and more stable basis, and carries no clawback.

## Excluded content

The following are deliberately excluded from this corpus, and their absence is not a coverage gap:

- Judgments and orders reciting an in-camera or non-publication direction (outside section 52(1)(q)(iv)).
- Matters where publication of identifying detail is barred by statute: **BNS section 72** (formerly IPC section 228A, sexual-offence victims), **Juvenile Justice (Care and Protection of Children) Act 2015 section 74** (children in conflict with law, children in need of care and protection, child victims and witnesses), the **POCSO Act**, and **HIV and AIDS (Prevention and Control) Act 2017 section 34**.
- Any material sourced from a commercial law reporter.
  Under *Eastern Book Company v. D.B. Modak*, (2008) 1 SCC 1, raw judgment text carries no publisher copyright, but copy-edited law-report versions (headnotes, editorial paragraph numbering, cross-references) can.
  Only court, tribunal and government publishers are used.

See the dataset card for the exact exclusion rules applied and the counts removed.

## Reporting a problem

If this corpus contains material that should not be public - a masking order we have not honoured, an identity that should have been redacted, or a document a court has since directed be withdrawn - write to **contact@vaquill.ai** with the subject line `Open India Law - redaction request`.

We honour directions of Indian courts and tribunals.
Because a published snapshot is a fixed artifact with published checksums, corrections are made by publishing a superseding snapshot and withdrawing the affected one, not by editing a release in place.

## No warranty; not legal advice

This dataset is provided "as is," without warranty of any kind.
Each snapshot is a **point-in-time archive**, not the current state of the law, and may be incomplete or contain errors.
It is **not legal advice**.
Always verify any provision or judgment against its official source before relying on it.

---

SPDX-License-Identifier: CC-BY-4.0

Copyright (c) 2026 Vaquill AI - compilation and metadata only.
The underlying legal text is a Government work under section 17(d) of the Copyright Act 1957, reproduced under section 52(1)(q).
