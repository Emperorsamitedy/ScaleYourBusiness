# Site Audit and Change Proposals — Spec Addendum

Addendum to `data-model-v1.md` and `build-sequence.md`. Covers auditing the owner's website, proposing changes, showing a visual before and after, and applying approved changes.

---

## 1. The three tiers

This ships in three stages with very different risk profiles. Conflating them is how you end up breaking someone's checkout in month four.

| Tier | Phase | Needs | Risk |
|---|---|---|---|
| **1 · Audit** | 1 | Just the URL | None |
| **2 · Evidence** | 2 | Analytics connector | None |
| **3 · Change** | 3 | Write credentials | **High** |

**Tier 1 needs nothing but the URL the owner already gave at question 2.1.2.1.** No credentials, no permissions, no risk — it's a public website. That makes it one of the strongest findings sources available for the first diagnosis report, and it should ship with Phase 1.

---

## 2. Tier 1 — Audit

### What "check it as a customer" actually means

An agent can't feel its attention drifting. What it can do is walk the real purchase path and measure things that are known to correlate with drop-off, then reason about them against the specific business.

**Walk the path.** Home → category → product → cart → checkout entry. For a service business: home → service page → booking or contact. Each step rendered at desktop and mobile viewport.

**Measure what's measurable.** Largest Contentful Paint, Cumulative Layout Shift, total page weight, tap target sizes, colour contrast, form field count, number of clicks to purchase, presence of price above the fold, mobile viewport overflow, broken links and images.

**Then reason over the screenshots.** This is where a vision model earns its place: is the primary action visually obvious, is the value proposition legible in the first screen, does anything look broken, is the page asking for effort before giving value.

The measured layer and the reasoning layer are separate on purpose. "Your product page takes 6.2 seconds to load on mobile" is a fact. "The buy button competes with three other buttons of equal weight" is a judgement. The report should present them differently, and every judgement should cite the screenshot it came from.

### Schema

```ts
interface SiteAudit {
  id: AuditId;
  profile_id: BusinessProfileId;
  url: string;
  ran_at: ISODateTime;
  pages: AuditedPage[];
  findings: SiteFinding[];
  platform: DetectedPlatform;
  editable: boolean;              // see §5
}

interface AuditedPage {
  url: string;
  role: "home" | "category" | "product" | "cart" | "checkout" | "service" | "contact" | "other";
  screenshot_desktop: AssetId;
  screenshot_mobile: AssetId;
  metrics: PageMetrics;
  dom_snapshot: AssetId;          // stored for diffing later
}

interface SiteFinding {
  id: FindingId;
  page_url: string;
  kind: "measured" | "judged";
  severity: "critical" | "high" | "medium" | "low";
  title: LocalizedText;
  detail: LocalizedText;
  evidence: { screenshot: AssetId; metric?: string; value?: number };
  step_in_journey: number;        // where in the path it sits
}
```

`SiteFinding` feeds `DiagnosisFinding` in the report like any other finding, with the screenshot as evidence.

### As built — Phase 5 Session C (P5-11..13, 2026-10-27)

Tier 1's **measured layer** is built without running a browser of our own (TASKS-PHASE5.md, step 90): Google's public PageSpeed Insights API v5 loads the pages and measures them, and SYB reads the pages' HTML through the GET-only, SSRF-guarded fetcher. The **judged layer** (screenshots and a vision model) is not built, so every finding is `kind: "measured"`. Code: `lib/site/audit/`. Rule 30 governs it: the audit never logs in, never submits a form, never adds to a cart (cart action links are refused even though they are links) and never opens checkout. Checkout is counted from the outside.

What changed against the schema above, deliberately:

- `AuditedPage.role` gains `"booking"`. A booking link to a hosted service (Fresha, Booksy, Calendly, …) counts as the booking entry and is never fetched.
- `AuditedPage` has no screenshots and no `dom_snapshot`. Its metrics are the PageSpeed result per strategy: field data (CrUX p75 LCP, CLS, INP, with `origin_fallback`) kept apart from lab data (LCP, CLS, Total Blocking Time as INP's stand-in, page bytes, performance score, contrast and tap-target failures). Each result carries its provenance: source, API, `measured_at`, Lighthouse version, final URL, and whether a key or the shared quota was used.
- `SiteFinding.evidence.screenshot` is `null`. The evidence gains `unit`, `basis` (`field` | `field_origin` | `lab` | `page_read`), `strategy`, `source` and `measured_at`.
- `SiteFinding` gains `code`, `threshold` (the stated line it crossed, in words, with whose it is) and `euro`: a monthly range with its formula, window, sources and ASSUMED lines, or `{computed: false, why}`. Only the slow-mobile-load finding carries a computed figure, and only from the owner's own visits, orders and revenue (rule 25).
- Severity comes from `SITE_THRESHOLDS` (`lib/site/audit/findings.ts`), tested at the boundaries. The vitals use Google's bands. Page weight, failures, clicks and form fields use SYB's own stated lines.
- Into the report: up to four findings of medium and above become `DiagnosisFinding`s (`kind: "measured"`). They cite the `presence.site_audit` fact, which names the audit it came from. A report built from a snapshot therefore reproduces its site findings.

Stored in `site_audits` (migration 0063), one row per run, with the PageSpeed calls it made. The weekly per-site cap counts those calls.

---

## 3. Tier 2 — Evidence

Tier 1 audits are heuristic. Once GA4 is connected in Phase 2, the system can see where real customers actually leave.

That changes the quality of the output completely. Instead of "your product page is slow", it becomes: *"68% of mobile visitors leave your product page without scrolling. It takes 6.2 seconds to load and the price sits below the fold."* Measured behaviour plus measured cause plus a specific page.

**Rank findings by observed drop-off, not by audit severity.** A critical accessibility issue on a page nobody visits matters less than a medium issue on the page where 68% of your traffic leaves. Without analytics you're guessing at priority; with it you're not.

---

## 4. Tier 3 — Change

The dangerous tier. Everything here exists to make automatic modification of a live business website survivable.

### The flow

1. Finding identified, with evidence
2. Change generated as a diff against the real theme
3. Applied to a **preview copy**, never to live
4. Both versions rendered and screenshotted
5. Proposal enters the approval queue with the visual comparison
6. On approval: applied to live, with the previous version stored
7. Measured for a defined window
8. One-click rollback available permanently

### The before and after

```ts
interface ChangeProposal {
  id: ProposalId;
  audit_finding_id: FindingId;
  page_url: string;
  diff: string;                      // the actual change, stored not shown
  preview_url: string;               // owner can click through the real thing
  before_desktop: AssetId;
  after_desktop: AssetId;
  before_mobile: AssetId;
  after_mobile: AssetId;
  plain_explanation: LocalizedText;  // what changed, in owner's language
  expected_effect: ScenarioBlock;
  reversible: true;
  applied_at: ISODateTime | null;
  rolled_back_at: ISODateTime | null;
}
```

**Rendered, never generated.** Both screenshots come from a real browser rendering real HTML. The "after" is a screenshot of the preview copy with the change actually applied. This is not a stylistic preference — a generated approximation would be showing the owner something that doesn't exist, and they'd approve it on that basis.

**The diff is stored but not shown by default.** Owner sees images, a plain-language sentence, and a link to click through the real preview on their phone. "View the code" stays available for the minority who want it.

**Mobile and desktop both.** Most small business traffic is mobile and most owners look at their site on desktop. Showing only one hides the case that matters.

### Hard rules

**Never touch checkout or payment flow automatically.** Ever, at any tier, regardless of approval. Findings on those pages are reported with instructions for the owner or their developer to apply manually. The downside of a broken checkout is immediate lost revenue, and no conversion improvement justifies that risk profile.

**One change at a time per page.** Batched changes can't be attributed and can't be cleanly reverted.

**Rollback is permanent, not a time window.** Store the previous version indefinitely. An owner discovering a problem three weeks later must be able to undo it.

**Auto-rollback on hard failure only** — page errors, checkout unreachable, load time regression beyond a threshold. **Do not auto-rollback on conversion dips.** Short-window conversion data is noise, and a system that reverts itself on noise will thrash and destroy trust.

**Watching mode blocks this entirely.** Tier 3 is execution and doesn't exist during the watching period.

**Hard limits apply.** An owner who said "never change how the site looks" gets audit findings and no change proposals.

---

## 5. Platform reality

This is where the feature stops being universal, and the plan should be honest about it from the start.

| Platform | Tier 1 | Tier 3 | How |
|---|---|---|---|
| Shopify | Yes | **Yes** | Theme API, duplicate theme as preview, publish to swap. Best case by a distance. |
| WooCommerce / WordPress | Yes | Yes | REST API or a small plugin. Needs a staging environment. |
| Webflow | Yes | Partial | API covers some elements, not all |
| Custom, git-hosted | Yes | Yes | Open a pull request. Preview from the branch deploy. |
| **Wix** | Yes | **No** | No programmatic HTML editing |
| **Squarespace** | Yes | **No** | No programmatic HTML editing |

For Wix and Squarespace — a meaningful share of small business sites — Tier 3 cannot work. But the rendered before/after is still valuable: show the owner exactly what the improved version looks like and give step-by-step instructions to make the change in their editor. That converts an impossible feature into a useful one, and it's a much better answer than silently having nothing for a third of your customers.

Detect the platform during Tier 1 and set `editable` accordingly. Never promise automatic changes to a customer whose platform can't take them.

---

## 6. Consent and credentials

Modifying a customer's website needs more than a checkbox.

- Explicit, separate authorisation from the general terms, naming what the system may modify
- Scoped credentials — theme write access only, never admin, never payments
- Every change written to the decision log with the diff, the approving user, and the timestamp
- The owner can revoke write access at any time without losing the audit tiers
- If credentials fail, degrade to Tier 1 and say so rather than failing silently

---

## 7. Cost

Screenshots are image tokens and they aren't free.

| Item | Estimate |
|---|---|
| Tier 1 audit, 10 pages × 2 viewports | ~68k image tokens, **€0.20** |
| Reasoning over screenshots | **€0.10** |
| Rendering infrastructure | headless browser, shared |
| Per change proposal, 4 renders | **€0.08** |

**Full audit: about €0.30.** Run it once at onboarding and monthly thereafter — roughly €0.30/month per subscriber, on top of the Phase 2 figure.

Two controls: cap audits at 10 pages for the standard tier, and cache DOM snapshots so a monthly re-audit only re-renders pages that actually changed.

---

## 8. Build sequence additions

- **Step 44a** (Phase 1) — headless rendering, Tier 1 audit, findings into the diagnosis report. No credentials required.
- **Step 62a** (Phase 2) — join audit findings to GA4 drop-off, rank by observed traffic.
- **Step 74a** (Phase 3) — platform detection and credential handling, preview environments per platform.
- **Step 74b** (Phase 3) — change generation, dual rendering, the visual approval card, apply and rollback.
- **Step 74c** (Phase 3) — the manual-instructions path for Wix and Squarespace.

---

## 9. Why Tier 1 first is the whole point

Tier 1 requires no credentials, carries no risk, works on every platform including Wix, and produces some of the most concrete findings in the entire diagnosis report — a screenshot of an owner's own product page with the problem circled is more persuasive than any amount of analysis prose.

It's also the cheapest way to find out whether owners care about this at all. If the site findings in the Phase 1 report are the thing customers respond to, that's strong evidence Tier 3 is worth the considerable risk it carries. If they ignore them, you've learned that before writing a single line of code that touches a live website.
