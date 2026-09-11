# Compliance

## Read this first

**Software does not make a business compliant.** This platform provides
technical controls that make compliance _possible to demonstrate_ — recorded
approvals, immutable history, traceable stock. It cannot tell you whether your
product is correctly classified, whether your label is lawful, or whether a
particular claim is permissible.

Before selling anything, obtain US legal and regulatory review covering:

- Product classification (dietary supplement, cosmetic, food, device, general
  wellness — the obligations differ substantially)
- Labelling, including Supplement Facts and allergen declarations
- Every marketing claim, in every channel
- Manufacturing arrangements and supplier qualification
- Privacy and state consumer-protection law
- Sales tax nexus and registration
- Shipping restrictions

Nothing in this repository asserts that any product is FDA approved, and the
system will not let you assert it without a recorded review.

## The regulatory landscape this is built for

At a high level, and not as legal advice:

**Dietary supplements** are regulated under DSHEA. They are not pre-approved by
the FDA. A _structure/function_ claim ("supports normal immune function") is
generally permissible with substantiation and the standard disclaimer. A
_disease_ claim ("treats influenza") makes the product an unapproved drug.

**Cosmetics** may make appearance claims but not claims of altering structure or
function.

**General wellness devices** have their own FDA guidance and a narrower set of
permissible claims.

The distinction between a permissible structure/function claim and an
impermissible disease claim is a legal judgement about specific wording. The
platform's job is to ensure a human with the authority to make that judgement
made it, on the record, before the wording went public.

## What the platform enforces

### Separation of duty (built, Phase 1)

`COMPLIANCE_REVIEWER` is the only role holding `CLAIM_APPROVE`,
`EVIDENCE_APPROVE` and `COMPLIANCE_APPROVE`. `ADMIN` deliberately does not.
Someone administering the store cannot approve a medical claim, and the audit
trail always shows who did.

The role requires MFA, and the requirement cannot be turned off by its holder.

### Append-only history (built, Phase 1)

`audit_logs` and `customer_consents` reject UPDATE and DELETE at the database
level, not merely in the application. A bug, an ORM `updateMany`, or a
compromised service account cannot rewrite the record of who approved what.

This matters because the value of a compliance record is entirely in its
credibility. A record that _could_ have been edited is not evidence.

### Consent as a ledger (built, Phase 1)

Marketing consent is not a boolean that gets overwritten. Every grant and every
withdrawal is a new row carrying the timestamp, source, truncated IP and user
agent. Answering "did this person consent, when, and to what?" is a query, not
an argument.

### Recorded reasons (built, Phase 1)

Changing a role assignment or a system setting requires a written reason, stored
with the before and after state. "Why does this account have this access?" has an
answer.

### Publishing gate (built, Phase 2 — two checks await Phase 4)

A product cannot become publicly visible until a checklist passes. The gate is a
hard block, not a warning, and it is evaluated server-side at the moment of the
transition — not when the admin screen was rendered, so a stale screen cannot
publish a listing that has since lost its approval.

| Check                | Evaluated | Notes                                                 |
| -------------------- | --------- | ----------------------------------------------------- |
| Product information  | Phase 2   | Name, descriptions, brand, manufacturer, origin       |
| Price configured     | Phase 2   | Non-zero, and a compare-at price that is real         |
| Images available     | Phase 2   | A hero image, and alternative text on every one       |
| Label available      | Phase 2   | Label photograph, and a facts panel where required    |
| Ingredients complete | Phase 2   | An amount, or an explicit note explaining its absence |
| Allergen disclosure  | Phase 2   | See below                                             |
| Required disclaimers | Phase 2   | DSHEA on supplements; general health on everything    |
| SEO metadata         | Phase 2   | Present and within displayed lengths                  |
| Categorised          | Phase 2   | At least one, with a primary for the canonical URL    |
| Compliance approved  | Phase 2   | Signed off, and not expired                           |
| Claims reviewed      | Phase 4   | Reported `NOT_YET_ENFORCED` until then                |
| Evidence reviewed    | Phase 4   | Reported `NOT_YET_ENFORCED` until then                |
| Inventory configured | Phase 3   | Every sellable variant stocked in an active warehouse |

**Nothing passes by omission.** A check whose domain does not exist yet reports
`NOT_YET_ENFORCED` and is listed explicitly, on the API and on the admin screen.
It does not block — nobody could satisfy it — but it is never counted as a pass.
A checklist that quietly approves is worse than no checklist, because it looks
like assurance.

**Which checks are required is configuration**, held in
`catalog.publish_checklist_relaxed`. What a business must verify before
publishing is a legal question, and an operator can change it without a deploy.

That setting is a **relaxation list, not an inclusion list**, and the direction
matters more than it looks. Under an inclusion list, a check added in a later
release does not appear in the stored list and therefore does not block — a new
safeguard silently does nothing on every existing deployment, and nobody finds
out. Under a relaxation list, every declared check blocks unless an operator has
deliberately named it as relaxed, so the failure mode of forgetting to update
configuration is a gate that is too strict rather than one that is not there.
Naming a check stops it blocking publication; it does not stop the finding being
evaluated or reported.

**Allergen disclosure.** Under FALCPA, extended by the FASTER Act to include
sesame, a major allergen must be declared. If any ingredient on a listing is
flagged as an allergen, the listing must carry an allergen disclaimer or a
warning that names it. The system will not write that text: naming an allergen
is a labelling statement, and a generated one is exactly the kind of plausible
fabrication that must never reach a customer.

**Approvals lapse.** An approval is valid for
`compliance.claims_review_interval_days`, after which the check fails again. An
approval granted against evidence that has since been superseded is not an
approval.

**Material changes re-open the approval** and take a live listing down with it:
the formulation, the manufacturer, the country of origin, the product type, the
name, the warnings, the disclaimers, the label or facts-panel photograph, or a
new warning on any ingredient the product contains. The last is deliberately
blunt — deciding which changes to safety information are minor enough to skip is
not a judgement this system is entitled to make.

### Order, payment and stock history (built, Phase 3)

Three more histories are append-only at the database level, enforced by triggers
that reject `UPDATE` and `DELETE` regardless of what the application asks for:

- **Order events** — the record of what happened to an order and who did it.
  Notes added by staff land here too, and cannot be edited or removed
  afterwards.
- **Inventory adjustments** — every movement of stock, signed, with a required
  reason and the resulting on-hand figure, so a discrepancy is reconstructable
  without replaying anything.
- **Refunds** — attributable to a named person who completed multi-factor
  authentication, with a written reason that cannot be edited.

Money is never computed from anything a client sends. Prices come from the
catalogue, shipping from configured rates, and the refund ceiling from what the
payment provider says remains captured. Database `CHECK` constraints enforce the
arithmetic independently: an order total must equal its parts, a refund cannot
exceed what was paid, and stock cannot go negative — whatever the application
believes.

**Card data never reaches this application.** No interface in the system accepts
a card number, an expiry or a security code, and there is no shape in which one
could be passed. The order screen shows only the card brand and last four digits
the provider reports, which are display strings and cannot be used to charge
anything. That is what keeps the server out of PCI DSS scope, and it is not a
setting.

**Tax is not calculated.** A configured rate is applied, or none is and tax is
zero with `taxRateApplied: null` so the two are distinguishable. This is not a
sales tax determination and must not be treated as one; taking real money
requires a tax engine integration first. See the Phase 3 notes in the roadmap.

### Claim lifecycle (Phase 4)

```
DRAFT → EVIDENCE_REQUIRED → UNDER_REVIEW → APPROVED
                                        ↘ REJECTED
                            APPROVED → EXPIRED (review interval elapsed)
```

An approved claim is never overwritten. Editing one creates a new version
retaining the previous text, the new text, who changed it, when, why, the
evidence, and the approval history. Approvals expire on a configurable interval
(`compliance.claims_review_interval_days`) so a claim approved years ago against
since-superseded evidence does not stay live by default.

### Evidence (Phase 4)

Each record captures source type (RCT, systematic review, meta-analysis,
observational, lab, manufacturer data, regulatory, other), citation, study type,
population, dosage, duration, outcome, **limitations**, relevance, and who
reviewed it.

Limitations are a required field. Evidence without stated limitations tends to
be evidence being oversold.

### Traceability and recall (Phase 4)

Stock is tracked by batch and lot with manufacture and expiry dates. Allocation
is first-expiry-first-out and excludes expired, quarantined and recalled stock.

When a lot is recalled the system stops allocation, quarantines remaining stock,
and derives affected products → orders → customers. It does **not** contact
anyone automatically: customer notification during a recall is a decision with
legal consequences, and it requires explicit approval.

## What AI may and may not do (Phase 7)

May: summarise approved evidence, draft content for human review, answer
questions from approved knowledge, analyse sales.

May not: approve a claim, change compliance status, invent evidence or
certifications, assert FDA approval, diagnose, prescribe, alter dosage, issue
refunds, adjust inventory, or bypass RBAC.

For anything sensitive, AI creates a task for a human. It never completes the
action.

When the system lacks sufficient approved information to answer a health-related
question, it must say so. A plausible-sounding fabrication about a supplement is
worse than no answer.

## Data protection

- Collect only what the business needs.
- Do not collect health information unless there is a specific, legally reviewed
  reason. There is no health-profile model in this schema, and that is
  deliberate.
- Customer health information must never reach analytics, logs, AI prompts,
  URLs, browser storage or error messages.
- Consent history is retained as evidence and is not deleted by the application.

## Records to retain

| Record                       | Retained     | Why                           |
| ---------------------------- | ------------ | ----------------------------- |
| Claim approvals and versions | Indefinitely | Substantiation history        |
| Evidence and reviews         | Indefinitely | Substantiation history        |
| Batch and lot records        | Per policy   | Traceability, recall scope    |
| Recall actions               | Indefinitely | Regulatory record             |
| Audit log                    | Per policy   | Who did what, when            |
| Consent ledger               | Per policy   | Proof of permission           |
| Order and payment records    | Per tax law  | Financial and tax obligations |

"Per policy" means: decided with counsel, then implemented as a privileged
out-of-band job. The application itself cannot delete these — see
[../operations/RETENTION.md](../operations/RETENTION.md).

## Before launch

- [ ] Regulatory counsel has reviewed product classification
- [ ] Every claim reviewed and approved through the platform
- [ ] Labels reviewed
- [ ] Supplier and manufacturer qualification documented
- [ ] Adverse-event reporting process defined and staffed
- [ ] Recall procedure documented and rehearsed
- [ ] Privacy policy and terms reviewed by counsel
- [ ] Sales tax nexus assessed and registrations filed
- [ ] Shipping restrictions confirmed per product and destination
- [ ] Insurance in place
- [ ] Retention periods set with counsel and implemented
- [ ] Staff trained on what they may and may not say about a product
