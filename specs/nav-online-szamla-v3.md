# NAV Online Számla API v3 — the facts SYB relies on

Read-only use only (the multi-market spec, Part E). Each fact is marked
**verified** (read in the source named) or **unverified** (needs NAV's own
interface specification, or counsel). Sources read 2026-11-10:

- `pzs/nav-online-invoice` (PHP, master): `BaseRequestXml.php`, `Config.php`,
  `Util.php`, `RequestIdGeneratorBasic.php`, `Query*RequestXml.php`,
  `Reporter.php`, and its copies of `common.xsd`, `invoiceBase.xsd`,
  `invoiceApi.xsd` (v3.0, dated 2020-11-09).
- `nav-gov-hu/Online-Invoice` README. NAV's spec PDFs (revisions up to
  2026-02-12) were **not** read; the XSD copy may lag them.

## Endpoints — verified

- Test: `https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3`
- Prod: `https://api.onlineszamla.nav.gov.hu/invoiceService/v3`
- `POST /queryTaxpayer`, `POST /queryInvoiceDigest`, `POST /queryInvoiceData`.
  SYB calls nothing else. `manageInvoice`, `manageAnnulment` and
  `tokenExchange` are write-path operations and are never reachable.

## Request envelope — verified

- Root `<Query…Request xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"
  xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">`; children in order: header,
  user, software, body.
- `common:header`: `requestId`, `timestamp`, `requestVersion` = `3.0`,
  `headerVersion` = `1.0`.
- `requestId`: pattern `[+a-zA-Z0-9_]{1,30}`, unique per taxpayer.
- `timestamp`: UTC, `YYYY-MM-DDTHH:mm:ss.sssZ`.
- `common:user`: `login`, `passwordHash cryptoType="SHA-512"`,
  `taxNumber` (8 digits), `requestSignature cryptoType="SHA3-512"`.
- `passwordHash` = uppercase hex SHA-512 of the plain password.
- `requestSignature` (query operations) = uppercase hex SHA3-512 of
  `requestId + yyyyMMddHHmmss (UTC, the header's timestamp without
  milliseconds) + signatureKey`.
- The exchange key is used only to decrypt `tokenExchange` tokens for
  `manageInvoice`/`manageAnnulment`. A query-only client never needs it, and
  SYB never asks for it.

## Software block — verified, except registration

- `softwareId` (required): exactly 18 characters, `[0-9A-Z\-]{18}`.
- `softwareName`, `softwareOperation` (`LOCAL_SOFTWARE` | `ONLINE_SERVICE`),
  `softwareMainVersion`, `softwareDevName`, `softwareDevContact`: required.
- `softwareDevCountryCode`, `softwareDevTaxNumber`: **optional**.
- **Unverified:** whether NAV requires the software ID to be registered, and
  whether that needs a Hungarian legal entity. The XSD documents the ID only
  as "Billing software ID" and the PHP client treats it as configuration. The
  multi-market spec makes this a stop-and-ask point; it stays open with
  counsel, and SYB makes no live call to NAV until it is answered.

## queryTaxpayer — verified

- Body: `<taxNumber>` (8 digits).
- Response: `taxpayerValidity` (boolean), `taxpayerData` with
  `taxpayerName`, `taxpayerShortName`, `taxNumberDetail`, `incorporation`
  (`ORGANIZATION` | `SELF_EMPLOYED` | `TAXABLE_PERSON`), addresses.

## queryInvoiceDigest — verified, except the range limit

- Body: `page` (≥ 1), `invoiceDirection` (`OUTBOUND` = issued by the
  taxpayer → revenue; `INBOUND` = received → cost), `invoiceQueryParams`.
- `mandatoryQueryParams` is a choice of one: `invoiceIssueDate`
  (`dateFrom`, `dateTo`, dates ≥ 2010-01-01), `insDate` (UTC datetimes) or
  `originalInvoiceNumber`.
- Response: `currentPage`, `availablePage`, `invoiceDigest` items with
  `invoiceNumber`, `invoiceOperation` (`CREATE` | `MODIFY` | `STORNO`),
  `invoiceCategory`, `invoiceIssueDate`, `supplierTaxNumber`, `supplierName`,
  `customerTaxNumber`, `customerName`, `currency`, `invoiceNetAmount`,
  `invoiceNetAmountHUF`, `invoiceVatAmount`, `invoiceVatAmountHUF`,
  `insDate`, `completenessIndicator`.
- Amounts are decimals with at most 2 places; **there is no gross field** —
  gross is net + VAT.
- **Unverified:** the maximum date range per query. SYB queries one
  calendar month at a time until NAV's spec is read.

## Errors — verified shape, unverified codes

- Every response has `result/funcCode` (`OK` | `ERROR`), optional
  `errorCode` (free text), `message`. A `GeneralErrorResponse` adds
  technical validation messages.
- **Unverified:** the meanings of specific error codes (for example which
  ones mean a revoked or wrong technical user). SYB treats any non-OK
  result on `queryTaxpayer` as "the technical user doesn't work" and asks
  the owner to check it, in Hungarian.
