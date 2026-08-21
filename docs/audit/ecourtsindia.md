Authentication
All API requests (except Court Structure) require Bearer token authentication. Include your API token in the Authorization header.

Bearer Token Format
Authorization: Bearer eci_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Prefix: eci_live_
Length: 41 characters
Format: Alphanumeric
Response Format
All successful responses follow this structure:

JSON

{
  "data": { ... },
  "meta": {
    "requestId": "req_abc123xyz"
  }
}
Security Warning
Keep your API token confidential. Do not expose it in client-side code.
Never commit tokens to version control or share in public repositories.
If compromised, contact us immediately to regenerate your token.
API Endpoints
8 endpoints covering case data, orders, cause lists, and court structure across all Indian courts.

GET
/api/partner/case/{cnr}
₹0.50
Case Detail
Get complete case information by CNR (Case Number Record) including parties, advocates, judges, hearing history, orders, IAs, tagged matters, and more.

Parameters
Parameter	Type	Required	Description
cnr	path	Yes	Case Number Record
e.g. DLHC010001232024
Example Request
cURL

curl -X GET "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024" \
  -H "Authorization: Bearer eci_live_your_token_here"
Example Response
200 OK
JSON

{
  "data": {
    "courtCaseData": {
      "cnr": "DLHC010001232024",
      "caseNumber": "CS(OS) 123/2024",
      "caseType": "CIVIL",
      "caseStatus": "PENDING",
      "filingDate": "2024-01-15",
      "registrationDate": "2024-01-20",
      "firstHearingDate": "2024-02-01",
      "nextHearingDate": "2024-03-15",
      "decisionDate": null,
      "judges": ["Justice A.K. Sharma", "Justice B.L. Gupta"],
      "petitioners": ["ABC Private Limited", "John Doe"],
      "petitionerAdvocates": ["Adv. Rahul Sharma"],
      "respondents": ["XYZ Corporation", "State of Delhi"],
      "respondentAdvocates": ["Adv. Amit Patel"],
      "actsAndSections": "Code of Civil Procedure, 1908 - Section 9",
      "courtName": "Delhi High Court",
      "state": "Delhi",
      "district": "New Delhi",
      "courtNo": 12,
      "benchName": "Division Bench",
      "purpose": "Arguments",
      "judicialSection": "CIV"
    },
    "entityInfo": {
      "cnr": "DLHC010001232024",
      "nextDateOfHearing": "2024-03-15T00:00:00Z",
      "dateCreated": "2024-01-15T10:30:00Z",
      "dateModified": "2024-02-16T08:45:00Z"
    },
    "files": {
      "files": [{
        "pdfFile": "order-1.pdf",
        "markdownContent": "## ORDER\nDated: 01.02.2024...",
        "aiAnalysis": {
          "summary": "Court granted interim injunction...",
          "orderType": "INTERIM",
          "outcome": "PETITIONER_FAVORED",
          "keyPoints": ["Prima facie case established"],
          "reliefGranted": ["Interim injunction"],
          "legalProvisions": ["CPC, 1908 - Order XXXIX"]
        }
      }]
    },
    "caseAiAnalysis": {
      "caseSummary": "Commercial dispute arising from breach of contract...",
      "caseType": "CONTRACT_DISPUTE",
      "complexity": "MEDIUM",
      "keyIssues": ["Breach of contract", "Damages claim"]
    }
  },
  "meta": { "requestId": "req_abc123xyz" }
}
Response Schema
GET
/api/partner/search
₹0.20
Case Search
Full-text search across 24Cr+ records with filters for party, advocate, judge, court, case type, dates, and faceted results.

Text Search Parameters
Parameter	Type	Required	Description
query	string	No	General full-text search across all fields
advocates	string	No	Search by advocate name
judges	string	No	Search by judge name
petitioners	string	No	Search by petitioner name
respondents	string	No	Search by respondent name
litigants	string	No	Search both petitioners and respondents
Filter Parameters (arrays)
Date Range Filters
Sorting & Pagination
Important: Search results do not include a "case title" field. Construct a display title using petitioners/respondents arrays (e.g., "ABC Ltd vs XYZ Corp").
Example Request
cURL

curl -X GET "https://webapi.ecourtsindia.com/api/partner/search?advocates=Sharma&courtCodes=DLHC01&filingDateFrom=2024-01-01&pageSize=20" \
  -H "Authorization: Bearer eci_live_your_token_here"
Example Response
200 OK
JSON

{
  "data": {
    "results": [
      {
        "cnr": "DLHC010001232024",
        "caseType": "CIVIL",
        "caseStatus": "PENDING",
        "filingDate": "2024-01-15",
        "nextHearingDate": "2024-03-15",
        "judges": ["Justice A.K. Sharma"],
        "petitioners": ["ABC Private Limited"],
        "respondents": ["XYZ Corporation"],
        "petitionerAdvocates": ["Adv. Rahul Sharma"],
        "actsAndSections": ["Code of Civil Procedure, 1908 - Section 9"],
        "courtCode": "DLHC01",
        "judicialSection": "CIV",
        "aiKeywords": ["contract breach", "interim injunction"]
      }
    ],
    "totalHits": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8,
    "hasNextPage": true,
    "facets": {
      "caseType": { "values": { "CIVIL": 85, "WRIT": 42, "CRIMINAL": 18 }, "hasMore": false },
      "caseStatus": { "values": { "PENDING": 120, "DISPOSED": 30 }, "hasMore": false }
    }
  },
  "meta": { "requestId": "req_abc123xyz" }
}
GET
/api/partner/case/{cnr}/order/{filename}
₹1.25
Order Download (PDF)
Get order document metadata and download information. PDFs are certified true copies from the eCourts system.

Parameters
Parameter	Type	Required	Description
cnr	path	Yes	Case Number Record
e.g. DLHC010001232024
filename	path	Yes	Order filename from judgmentOrders[].orderUrl
e.g. order-1.pdf
How to get the filename:
Call GET /api/partner/case/{cnr} to get case details.
Look in courtCaseData.judgmentOrders[] or courtCaseData.interimOrders[] for orderUrl values.
Example Request
cURL

curl -X GET "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024/order/order-1.pdf" \
  -H "Authorization: Bearer eci_live_your_token_here"
Example Response
200 OK
JSON

{
  "data": {
    "cnr": "DLHC010001232024",
    "filename": "order-1.pdf",
    "downloadFilename": "ecourtsindia-truecopy-DLHC010001232024-order-1.pdf",
    "message": "Use the standard document download endpoint to retrieve the PDF"
  },
  "meta": { "requestId": "req_abc123xyz" }
}
GET
/api/partner/case/{cnr}/order-ai/{filename}
₹2.50
Order + AI Summary
Get extracted text and pre-computed AI analysis for a court order: summary, key points, outcome, relief granted, and legal provisions cited.

Parameters
Parameter	Type	Required	Description
cnr	path	Yes	Case Number Record
filename	path	Yes	Order filename from judgmentOrders[].orderUrl
Example Request
cURL

curl -X GET "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024/order-ai/order-1.pdf" \
  -H "Authorization: Bearer eci_live_your_token_here"
Example Response
200 OK
JSON

{
  "data": {
    "cnr": "DLHC010001232024",
    "filename": "order-1.pdf",
    "extractedText": "## ORDER\nDated: 01.02.2024\n\nPresent: Justice A.K. Sharma...",
    "aiAnalysis": {
      "summary": "The Delhi High Court granted interim injunction in a trademark infringement case...",
      "orderType": "INTERIM_INJUNCTION",
      "outcome": "PETITIONER_FAVORED",
      "keyPoints": [
        "Prima facie case established by petitioner",
        "Interim injunction granted under Order XXXIX Rules 1 and 2 CPC",
        "Respondent restrained from using infringing trademark",
        "Next hearing scheduled for 15.03.2024"
      ],
      "reliefGranted": [
        "Interim injunction against use of infringing trademark",
        "Restraint order against respondent"
      ],
      "parties": { "petitioner": "ABC Private Limited", "respondent": "XYZ Corporation" },
      "legalProvisions": ["CPC, 1908 - Order XXXIX Rules 1 and 2", "Trade Marks Act, 1999"],
      "nextSteps": "Matter listed for further proceedings on 15.03.2024",
      "judge": "Justice A.K. Sharma",
      "orderDate": "2024-02-01"
    }
  },
  "meta": { "requestId": "req_abc123xyz" }
}
AI Analysis Availability: AI analysis is pre-computed during our data processing pipeline, NOT generated in realtime. If aiAnalysis is null, analysis has not been processed yet.
GET
/api/CauseList/court-structure/*
Free
Court Structure
Discover the court hierarchy: State → District → Court Complex → Court. Public endpoints with no authentication required.

Public Endpoints: No authentication required. No billing. Use these to discover valid filter values for Cause List Search and Available Dates endpoints.
JSON

// GET /api/CauseList/court-structure/states
[
  { "state": "DL", "stateName": "Delhi" },
  { "state": "UP", "stateName": "Uttar Pradesh" },
  { "state": "SC", "stateName": "India" }   // Supreme Court
]
JSON

// GET /api/CauseList/court-structure/states/{state}/districts
[
  { "districtCode": "1", "districtName": "Prayagraj" },
  { "districtCode": "HC", "districtName": "Allahabad High Court" }
]
JSON

// GET .../districts/{districtCode}/complexes
[
  { "courtComplexCode": "1130029", "courtComplexName": "Kheri District Court Complex" }
]
JSON

// GET .../complexes/{code}/courts
[
  {
    "court": "11",
    "courtNo": "1",
    "courtName": "SUSHRI KAPILA RAGHAV-Presiding Officer MACT",
    "courtDivision": "Presiding Officer Motor Accident Claim Tribunal",
    "judgeName": "SUSHRI KAPILA RAGHAV"
  }
]
GET
/api/partner/causelist/search
₹1.00
Cause List Search
Search cause list entries across Indian courts with flexible filtering by date, judge, advocate, litigant, state, district, and court.

Query Parameters
Parameter	Type	Required	Description
q	string	No	Full-text search across case numbers, parties, and advocates
date	date	No	Exact date filter (YYYY-MM-DD)
startDate	date	No	Date range start (inclusive)
endDate	date	No	Date range end (inclusive)
judge	string	No	Search by judge name (full-text)
advocate	string	No	Search by advocate name (full-text)
state	string	No	Filter by state code (e.g., DL, JH)
districtCode	string	No	Filter by district code
limit	int	No	Maximum results to return (max: 100)
Default: 100
offset	int	No	Number of results to skip (for pagination)
Default: 0
At least one search or filter parameter must be provided.
Example Request
cURL

curl -X GET "https://webapi.ecourtsindia.com/api/partner/causelist/search?q=ram&state=JH&limit=10" \
  -H "Authorization: Bearer eci_live_your_token_here"
Example Response
200 OK
JSON

{
  "data": {
    "query": "ram",
    "results": [
      {
        "id": 8506606,
        "courtType": "DISTRICT_COURT",
        "listType": "CRIMINAL",
        "bench": "9",
        "courtNo": "1",
        "date": "2026-02-16",
        "caseNumber": ["G.R.case/533/2023"],
        "party": "The State Of Jharkhand Vs. Dilip Ram, Karan Ram",
        "petitioners": ["The State Of Jharkhand"],
        "respondents": ["Dilip Ram, Karan Ram"],
        "advocates": ["Appsri Shankar Thakur"],
        "judge": ["Manoj Kumar Prajapati"],
        "district": "Bokaro",
        "state": "JH",
        "status": "APPEARANCE",
        "districtCode": "1",
        "courtName": "Manoj Kumar Prajapati-Acjm"
      }
    ],
    "returnedCount": 2,
    "limit": 10,
    "offset": 0
  },
  "meta": { "requestId": "req_abc123xyz" }
}
Pagination: Uses offset-based pagination. First page: limit=20&offset=0, second page: limit=20&offset=20. If returnedCount < limit, you have reached the last page.
GET
/api/partner/causelist/available-dates
Free
Cause List Available Dates
Discover which dates have cause list data for a given location before searching. Free with authentication.

Query Parameters
Parameter	Type	Required	Description
state	string	No*	State code (e.g., DL)
districtCode	string	No*	District code
courtComplexCode	string	No*	Court complex code
Example Response
200 OK
JSON

{
  "data": [
    "2024-02-15",
    "2024-02-14",
    "2024-02-13",
    "2024-02-12",
    "2024-02-09"
  ],
  "meta": { "requestId": "req_abc123xyz" }
}
* At least one parameter must be provided.
POST
/api/partner/case/{cnr}/refresh
₹0.50
Case Refresh
Queue a fresh data scrape from the eCourts source. Use this to get the latest updates for a case.

Parameters
Parameter	Type	Required	Description
cnr	path	Yes	Case Number Record
e.g. DLHC010001232024
Example Request
cURL

curl -X POST "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024/refresh" \
  -H "Authorization: Bearer eci_live_your_token_here"
Example Response
202 Accepted
JSON

{
  "data": {
    "cnr": "DLHC010001232024",
    "status": "QUEUED",
    "message": "Case refresh request queued",
    "estimatedTime": "5-10 minutes"
  },
  "meta": { "requestId": "req_abc123xyz" }
}
This is an asynchronous operation. Fetch case details after 5-10 minutes to get updated data. Duplicate refresh requests within 15 minutes are idempotent.
Error Handling
All errors follow a consistent format with machine-readable error codes and human-readable messages.

JSON

{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": {}
  },
  "meta": {
    "requestId": "req_abc123xyz"
  }
}
Error Codes Reference
Status	Code	Description	Category
401	INVALID_TOKEN	Bearer token is invalid or malformed	Authentication
401	TOKEN_INACTIVE	Token has been deactivated	Authentication
403	ACCOUNT_INACTIVE	Partner account is suspended	Authorization
402	INSUFFICIENT_CREDITS	Not enough credits to complete request	Billing
402	SUBSCRIPTION_REQUIRED	Active subscription required to use credits	Billing
429	RATE_LIMIT_EXCEEDED	Too many requests. Please try again later.	Rate Limit
400	INVALID_CNR	CNR format is invalid	Validation
400	INVALID_PARAMETER	Request parameter is invalid	Validation
400	MISSING_PARAMETER	Required parameter is missing	Validation
400	PAGE_SIZE_EXCEEDED	Page size cannot exceed 100	Validation
404	CASE_NOT_FOUND	Case with given CNR not found	Resource
404	ORDER_NOT_FOUND	Order document not found	Resource
500	INTERNAL_ERROR	Internal server error (not charged)	Server
Rate Limits
Default limits for all partner accounts. Contact us for higher limits on enterprise plans.

Limit	Value
Per Minute	100 requests
Per Hour	3,000 requests
Per Day	50,000 requests
Concurrent	10 requests
Implement exponential backoff when receiving 429 responses. Wait 1s, 2s, 4s, etc. before retrying.
Code Examples
Complete, ready-to-use examples covering all endpoints.

cURL
Python
Node.js
C#

# Get case details
curl -X GET "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Search cases by advocate
curl -X GET "https://webapi.ecourtsindia.com/api/partner/search?advocates=Sharma&courtCodes=DLHC01&pageSize=20" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Search with date range and multiple courts
curl -X GET "https://webapi.ecourtsindia.com/api/partner/search?advocates=Sharma&courtCodes=DLHC01&courtCodes=HCBM01&filingDateFrom=2024-01-01&filingDateTo=2024-12-31&caseStatuses=PENDING" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Get order metadata (PDF)
curl -X GET "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024/order/order-1.pdf" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Get order with AI summary
curl -X GET "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024/order-ai/order-1.pdf" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Court Structure (public, no auth)
curl -X GET "https://webapi.ecourtsindia.com/api/CauseList/court-structure/states"
curl -X GET "https://webapi.ecourtsindia.com/api/CauseList/court-structure/states/UP/districts"

# Cause List Search
curl -X GET "https://webapi.ecourtsindia.com/api/partner/causelist/search?q=ram&state=JH&limit=10" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Available Dates (free)
curl -X GET "https://webapi.ecourtsindia.com/api/partner/causelist/available-dates?state=DL" \
  -H "Authorization: Bearer eci_live_your_token_here"

# Refresh case data
curl -X POST "https://webapi.ecourtsindia.com/api/partner/case/DLHC010001232024/refresh" \
  -H "Authorization: Bearer eci_live_your_token_here"
Enum Reference
Standard enumeration values used across API responses.

Case Status Values
Value	Description
PENDING	Case is pending/ongoing
DISPOSED	Case has been disposed/concluded
TRANSFERRED	Case transferred to another court
WITHDRAWN	Case withdrawn
UNKNOWN	Status unknown
Judicial Section Values
Common Case Types
High Court Codes
Best Practices
Cache responses: Store case details locally to reduce API calls and costs.
Batch operations: Use search to find multiple cases instead of individual lookups.
Handle rate limits: Implement exponential backoff for 429 responses.
Use refresh sparingly: Only request case refresh when you need the latest data.
Store request IDs: Log requestId from responses for support inquiries.
CNR Format
CNR (Case Number Record) is the unique identifier for every case in the eCourts system.

Format: {CourtEstablishmentCode}{CaseNo}{Year}
Example: DLHC010001232024
