# eCourts India API — Docs vs. Reality Report

**Date**: 2026-03-08
**Tested by**: Live API calls using partner token
**Credits spent during testing**: ~₹4.20 (1× search ₹0.20, 1× case detail ₹0.50, 1× order-ai ₹2.50, 1× cause list ₹1.00, free endpoints free)
**Purpose**: Share with eCourts India team — API documentation does not match actual response payloads

---

## Summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | 🔴 CRITICAL | `case_types` filter values | Docs say `CIVIL`/`WRIT` — API requires `CS`/`WP_C` |
| 2 | 🔴 CRITICAL | `order-ai` response schema | Docs show flat JSON — API returns 7-level nested object |
| 3 | 🟠 HIGH | `files.files[].pdfFile` | Docs show `order-1.pdf` — API returns `DLHC010321602007-order-1.pdf` |
| 4 | 🟡 MEDIUM | `meta.requestId` casing | Docs use camelCase — API returns `request_id` (snake_case) |
| 5 | 🟡 MEDIUM | `courtCaseData.cnr` missing in docs | Field exists in actual response, not shown in docs |
| 6 | 🟢 INFO | Extra undocumented fields | `enumDescriptions`, `activeFilters`, `courtrooms`, `descriptions` |

---

## Finding 1 — CRITICAL: `case_types` filter values are wrong in the docs

### What the docs say
```
Filter by case type:
CIVIL, CRIMINAL, WRIT, APPEAL, REVISION, EXECUTION, ARBITRATION, MATRIMONIAL, MOTOR_ACCIDENT, LABOR
```

### What the API actually accepts

```bash
# Test: caseTypes=WRIT (from docs)
GET /api/partner/search?courtCodes=DLHC01&caseTypes=WRIT&pageSize=1
→ totalHits: 0   ← RETURNS NOTHING

# Test: caseTypes=WP_C (actual code)
GET /api/partner/search?courtCodes=DLHC01&caseTypes=WP_C&pageSize=1
→ totalHits: 256,005  ← CORRECT
```

### Actual case type codes returned by the API

From a live search response (`enumDescriptions.enumLookup.caseType`):

| Code | Description |
|------|-------------|
| `WP_C` | Writ Petition (Civil) |
| `WP_CRL` | Writ Petition (Criminal) |
| `CS` | Civil Suit |
| `CRL_A` | Criminal Appeal |
| `BA` | Bail Application |
| `RFA` | Regular First Appeal |
| `FA` | First Appeal |
| `LPA` | Letters Patent Appeal |
| `CONMT` | Contempt Petition |
| `OMP` | Original Miscellaneous Petition |
| `ARB_PET` | Arbitration Petition |
| `ITA` | Income Tax Appeal |
| `MACA` | Motor Accident Claims Appeal |
| `CRP` | Civil Revision Petition |
| `CR_MISC` | Criminal Miscellaneous |
| `CRLP` | Criminal Leave Petition |
| `CMAppl` | Civil Miscellaneous Application |
| `RSA` | Regular Second Appeal |
| `LC` | Land Acquisition Case |
| `EA` | Execution Application |
| `XOBJ` | Cross Objection |
| `CA` | Civil Appeal |
| `SA` | Second Appeal |
| `IP` | Insolvency Petition |
| `TS` | Testamentary Suit |
| `Tax_Ref` | Tax Reference Case |
| `COP` | Company Petition |
| `DREF` | Death Reference |
| `RERA` | RERA Appeal |
| `NDPS` | NDPS Act Case |
| `ST` | Sessions Trial |

**Impact**: Any integration that uses the documented enum values for `caseTypes` filtering gets 0 results silently. This is a silent failure — no error is returned, just empty results.

**Fix needed in docs**: Replace the generic category list with the actual code table above.

---

## Finding 2 — CRITICAL: `order-ai` response schema is completely different

### What the docs say (flat structure)
```json
{
  "data": {
    "cnr": "DLHC010001232024",
    "filename": "order-1.pdf",
    "extractedText": "...",
    "aiAnalysis": {
      "summary": "The Delhi High Court granted interim injunction...",
      "orderType": "INTERIM_INJUNCTION",
      "outcome": "PETITIONER_FAVORED",
      "keyPoints": ["Prima facie case established", ...],
      "reliefGranted": ["Interim injunction against use of infringing trademark"],
      "parties": {"petitioner": "ABC Private Limited", "respondent": "XYZ Corporation"},
      "legalProvisions": ["CPC, 1908 - Order XXXIX Rules 1 and 2"],
      "nextSteps": "Matter listed for further proceedings on 15.03.2024",
      "judge": "Justice A.K. Sharma",
      "orderDate": "2024-02-01"
    }
  }
}
```

### What the API actually returns (actual CNR: DLHC010321602007)
```json
{
  "data": {
    "cnr": "DLHC010321602007",
    "filename": "order-1.pdf",
    "extractedText": "## ...",
    "aiAnalysis": {
      "foundational_metadata": {
        "core_case_identifiers": {
          "case_number_primary": "W.P.(C) 1687/2007",
          "case_type": "Writ Petition (Civil)",
          "judge_names": ["V. Kameswar Rao"],
          "order_date": "2016-01-05"
        },
        "party_information": {
          "petitioners_appellants_complainants": [{"name": "Munni Lal", "type": "Individual"}],
          "respondents_accused_defendants": [{"name": "Secretary, Ministry of Chemicals...", "type": "Government"}]
        },
        "procedural_details_from_order": {
          "order_nature": "Procedural",
          "disposition_status_indicated": "Disposed",
          "disposition_outcome_if_disposed": "Dismissed",
          "specific_directions_given_by_court": ["Petition dismissed in default due to non-appearance"]
        }
      },
      "search_and_user_friendly_teaser": {
        "teaser_content": {
          "short_summary_enticing": "A service matter writ petition...",
          "auto_generated_long_tail_keywords": [...]
        }
      },
      "deep_litigant_substance_context": { ... },
      "deep_legal_substance_context": {
        "core_legal_content_analysis": {
          "statutes_cited_and_applied": [],
          "case_law_cited_and_analysed": []
        },
        "arguments_and_reasoning_analysis": {
          "court_reasoning_for_decision": "The court dismissed the petition in default..."
        }
      },
      "intelligent_insights_analytics": {
        "order_significance_and_impact_assessment": {
          "ai_generated_executive_summary": "The Delhi High Court dismissed...",
          "plain_language_summary_for_litigants_outcome_focused": "Munni Lal's case has been permanently closed...",
          "actionable_alerts_for_parties": [{"action_required": "File review petition...", "deadline": null}],
          "practice_points_for_legal_professionals": [...]
        }
      },
      "actionable_outputs_user_tools": { ... },
      "quality_review_metadata": {
        "overall_extraction_confidence": "High",
        "ambiguity_or_missing_data_flags": [...]
      }
    }
  }
}
```

The documented flat keys (`summary`, `orderType`, `outcome`, `keyPoints`, `reliefGranted`, `legalProvisions`, `nextSteps`, `judge`, `orderDate`) **do not exist** in the actual response. Every one of them returns `null` if you try to read them.

**Field mapping — documented → actual path:**

| Documented field | Actual path |
|-----------------|-------------|
| `aiAnalysis.summary` | `aiAnalysis.intelligent_insights_analytics.order_significance_and_impact_assessment.ai_generated_executive_summary` |
| `aiAnalysis.orderType` | `aiAnalysis.foundational_metadata.procedural_details_from_order.order_nature` |
| `aiAnalysis.outcome` | `aiAnalysis.foundational_metadata.procedural_details_from_order.disposition_outcome_if_disposed` |
| `aiAnalysis.keyPoints` | `aiAnalysis.foundational_metadata.procedural_details_from_order.specific_directions_given_by_court` |
| `aiAnalysis.reliefGranted` | *(not a direct field — embedded in directions)* |
| `aiAnalysis.legalProvisions` | `aiAnalysis.deep_legal_substance_context.core_legal_content_analysis.statutes_cited_and_applied` |
| `aiAnalysis.judge` | `aiAnalysis.foundational_metadata.core_case_identifiers.judge_names` (array, not string) |
| `aiAnalysis.orderDate` | `aiAnalysis.foundational_metadata.core_case_identifiers.order_date` |
| `aiAnalysis.parties.petitioner` | `aiAnalysis.foundational_metadata.party_information.petitioners_appellants_complainants[].name` |
| `aiAnalysis.nextSteps` | `aiAnalysis.intelligent_insights_analytics.order_significance_and_impact_assessment.actionable_alerts_for_parties` |

**Note**: The same nested `aiAnalysis` schema also appears inside `files.files[].aiAnalysis` in the **case detail** (`/api/partner/case/{cnr}`) response. So this affects both endpoints.

**Request to eCourts team**: Please either (a) update the documentation to reflect the actual schema, or (b) provide a stable flat alias layer for the documented fields.

---

## Finding 3 — HIGH: `files.files[].pdfFile` has CNR prefix not shown in docs

### What the docs show (case detail response)
```json
"files": {
  "files": [{"pdfFile": "order-1.pdf", ...}]
}
```

### What the API actually returns
```json
"files": {
  "files": [{"pdfFile": "DLHC010321602007-order-1.pdf", ...}]
}
```

The `pdfFile` field contains a CNR-prefixed filename. However, `courtCaseData.judgmentOrders[].orderUrl` still returns the bare `order-1.pdf` without the prefix.

Both `order-1.pdf` and `DLHC010321602007-order-1.pdf` return HTTP 200 from the `order-ai` endpoint (tested live), so the API accepts both. However, integrations that use `pdfFile` for display or storage will show the longer CNR-prefixed name.

**Recommendation**: Document which field is the canonical filename to pass to `order-ai` and `order` endpoints.

---

## Finding 4 — MEDIUM: `meta.requestId` casing mismatch

### What the docs say
```json
{"meta": {"requestId": "req_abc123xyz"}}
```

### What the API actually returns
```json
{"meta": {"request_id": "40006d4d-0006-3c00-b63f-84710c7967bb"}}
```

Key name is `request_id` (snake_case), not `requestId` (camelCase). The UUID format also differs from the `req_` prefix shown in examples.

---

## Finding 5 — MEDIUM: `courtCaseData.cnr` present in response but missing from docs schema

The `courtCaseData` object in the case detail response contains a `cnr` field (`"cnr": "DLHC010321602007"`), but the docs response schema does not list it as a field in `courtCaseData`. It is only shown at the top-level example.

The actual `courtCaseData` object also contains many additional undocumented fields:
`caseTypeSub`, `causelistType`, `cnrCourtCode`, `courtComplexCode`, `cnrCaseNumber`, `cnrYear`, `caseTypeRaw`, `filingNumber`, `registrationNumber`, `registrationDate`, `firstHearingDate`, `hasOrders`, `hasJudgments`, `orderCount`, `interimOrderCount`, `judgmentCount`, `hearingCount`, `iaCount`, `taggedMatters`, `earlierCourtDetails`, `interlocutoryApplications`, `listingDates`, `notices`, `judgmentOrders`, `caveatDetails`

---

## Finding 6 — INFO: Response contains undocumented fields

### Case Search response
- `enumDescriptions.enumLookup` — maps all enum codes to human-readable labels (very useful!)
- `activeFilters` — shows which filters were applied and their display labels
- `facets.*.facetType` — `"categorical"` or `"range"`
- `processingTimeMs` — query latency in ms
- `hasPreviousPage` — pagination flag

### Case Detail response
- `descriptions` — top-level key (empty in tested case, purpose unknown)

### Cause List response
- `enumDescriptions` — same enum lookup pattern as search
- `courtrooms` — additional field (structure not inspected)
- `filters` — applied filters summary

---

## Agent / LLM integration note

The user asked: "if a user only has a name and case ID, how will the agent call the API?"

The agentic system (OpenAI tool calling) is **well-suited** for this pattern:

1. **User asks**: "What is the status of case ABC filed by Sharma at Delhi HC?"
2. **LLM decides** to call `search_court_cases` with only the params it knows:
   ```json
   {"advocates": "Sharma", "court_codes": ["DLHC01"]}
   ```
   All other params are optional — the API accepts 0 required fields.
3. **Results come back** with CNRs → LLM picks the right one and calls `get_case_by_cnr`
4. **Full case details** returned in next tool result

The LLM **does not need all 10 params** — it only sends what it knows. This is standard OpenAI tool-calling behavior. The JSON schema marks all search params as optional (`"required": []`), so the LLM is free to send 1 or 10 params depending on what the user provides.

---

## Bugs Fixed in Vaquill's Implementation (as of this report)

| Bug | Fix |
|-----|-----|
| `CASE_TYPES` enum had `CIVIL`/`WRIT` etc. — returns 0 results | Updated to actual API codes (`WP_C`, `CS`, etc.) in `agent_tools.py` and `ecourtsindia.py` |
| `_ecourts_get_order_summary` read `.get("summary")`, `.get("orderType")` etc. → all `None` | Updated to read correct nested paths in `tool_executor.py` |
| `_ecourts_get_case` orders summary read `(aiAnalysis).get("orderType")` → `None` | Updated to read `foundational_metadata.procedural_details_from_order.order_nature` |
| `pdfFile` used as filename for order-ai calls (has CNR prefix) | Changed to derive bare name from `judgmentOrders[].orderUrl` |

---

*Report generated after live API testing on 2026-03-08. Credits used: ~₹4.20.*
