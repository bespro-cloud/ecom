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

### Publishing gate (built, Phase 2 — fully enforced from Phase 4)

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
| Claims reviewed      | Phase 4   | Every recorded claim approved, unexpired and unedited |
| Evidence reviewed    | Phase 4   | Each approved claim has accepted supporting evidence  |
| Inventory configured | Phase 3   | Every sellable variant stocked in an active warehouse |

**Nothing passes by omission.** Every declared check now has a real evaluation
behind it; none report `NOT_YET_ENFORCED`. The mechanism stays in place for
checks added in future: one whose domain does not exist yet is listed explicitly
rather than counted as a pass, on the API and on the admin screen. A checklist
that quietly approves is worse than no checklist, because it looks like
assurance.

**And no check claims more than it verifies.** `CLAIMS_REVIEWED` checks the
claims someone recorded — it does not scan marketing copy for unrecorded ones —
and its reported detail says exactly that. A gate that let a green tick imply
automated claim detection would be worse than one that admits its scope.

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

### Compliance history (built, Phase 4)

Four more histories are append-only at the database level, enforced by triggers
that reject `UPDATE` and `DELETE`:

- **Claim versions** — the exact words a reviewer approved. Substantiation is a
  statement about specific words; if those words can change afterwards, the
  approval means nothing.
- **Claim decisions** — who approved what, on which version, on what evidence,
  and why. The evidence file is snapshotted into the decision, so "what was this
  approved on?" is answerable after the file grows.
- **Lot events** — every disposition change, with the reason. "Why was this stock
  blocked, by whom, and when was it released?" is a question a regulator asks,
  and an answer that could have been edited afterwards is not an answer.
- **Recall actions** — the regulatory record of a recall response, retained
  indefinitely. The application has no route that deletes one; lots cannot be
  removed from a recall's scope either, because which lots were withdrawn is the
  recall's factual core.

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

### Claim lifecycle (built, Phase 4)

```
DRAFT → EVIDENCE_REQUIRED → UNDER_REVIEW → APPROVED
                                        ↘ REJECTED (terminal)
                            APPROVED → EXPIRED (review interval elapsed)
                            any state → WITHDRAWN (terminal)
```

There is deliberately **no edge from `APPROVED` back to `DRAFT`**. Changing the
words of an approved claim is a new version, not a mutation of the approved one:
the claim record points at a version, revising moves the _current_ pointer, and
the _approved_ pointer stays exactly where it was. The listing renders the
approved version, so an edit in progress cannot reach a customer.

Rejection is terminal. A rejected claim is answered by writing a different claim,
not by re-submitting the same wording until a reviewer says yes.

A decision names the version it applies to and is refused if the wording moved
underneath. An approval that silently attached to a later edit would be a
signature on text the signatory never read.

Approvals lapse after `compliance.claims_review_interval_days`. An hourly sweep
expires them; the claim then disappears from the listing while the product stays
up, because pulling a whole page down over one lapsed sentence is a far bigger
customer impact than the lapse represents. The publishing gate separately refuses
to re-publish a listing carrying one.

**What the gate does and does not check.** `CLAIMS_REVIEWED` verifies that every
claim _someone recorded_ is approved, unexpired and unedited since approval. It
does **not** read the product description and decide whether it contains an
unrecorded claim. That inference about regulated speech is not one this software
makes, and it would fail in the direction nobody notices — the claim it missed is
exactly the one that goes out unreviewed. The human compliance review is where
someone attests the copy makes no claims beyond those recorded, and the check's
own detail text says so rather than letting a green tick imply more.

**A disease claim cannot be approved.** It is refused on category alone, however
much evidence is attached, because no amount of substantiation makes one lawful
on a supplement listing without the product being regulated as a drug. Recording
it is how the refusal stays on file.

### Evidence (built, Phase 4)

Each record captures source type (systematic review, meta-analysis, RCT,
observational, in vitro, animal, manufacturer data, regulatory guidance,
monograph, other), citation, identifier, population, dosage, duration, outcome,
**limitations**, and who added and reviewed it.

**Every field is typed by the person who read the source.** Nothing is fetched
from a DOI, nothing is summarised from a title, and there is no route that
populates `outcome` or `limitations` from anything. A system that generated the
finding a health claim rests on would be manufacturing substantiation, and it
would do it in the most convincing possible format.

Limitations are required, with a real minimum length in validation and again as a
database `CHECK`. Evidence without stated limitations tends to be evidence being
oversold, and it is the field that gets left blank first.

Relevance lives on the claim↔evidence link rather than on the evidence, because
the same trial can be direct support for one claim and background for another.
`CONTRADICTORY` is a value a reviewer records on purpose — a substantiation file
containing only supportive studies is a sales document, not a review — and it
cannot be what an approval rests on.

Evidence is a shared library. A single trial commonly supports several claims
across several products; copying it per claim means a correction has to be made
in several places, which is how substantiation files go stale. Reviewed evidence
cannot be edited: approvals rest on what it said, so a correction is a new record
and the claim is re-reviewed against it.

**There is no score.** The system counts accepted supporting sources; it does not
weigh whether a study supports a sentence. That judgement is the reviewer's job
and the whole substance of it, and a confidence figure would look like the
software had formed a view people would then rely on.

### Documents (built, Phase 4)

Certificates of analysis, GMP certificates, third-party test reports, allergen
statements and the rest are uploaded files with human-entered metadata, held
against a product or a specific lot.

**The system records what a person said a document is.** It does not verify the
issuer, does not check a certificate against any registry, and must never be read
as evidence that a certification is genuine or current. The API returns
`issuerAsStated` rather than `issuer`, and every document carries
`verification: "NOT_VERIFIED_BY_THIS_SYSTEM"` so no screen can imply otherwise.

A document past its stated expiry is reported as expired rather than quietly
omitted — a certificate that lapsed eight months ago is a finding, not an
absence. Superseding is a link, not an edit: the document that was current when a
particular lot shipped stays identifiable afterwards, which is the question an
investigation actually asks.

### Traceability and recall (built, Phase 4)

Stock is tracked by lot with manufacture and expiry dates. Allocation is
first-expiry-first-out and excludes expired, quarantined and recalled stock — the
filter is in the SQL that selects lots, not in a parameter a caller could widen.
An undated lot sorts last, not first: "no expiry recorded" is not evidence of
freshness.

A lot-tracked stock record with no allocatable lot **refuses to allocate**.
Shipping a regulated product without being able to say which lot it came from
defeats the point of tracking lots, so the refusal is the correct outcome rather
than a gap.

Quarantine and release each require a written basis, recorded in an append-only
ledger. Releasing is the more dangerous of the two to have no record of. Recalled
and expired stock can never return to sale; correcting a mistaken recall means
receiving the goods again as a new lot, with the receipt recorded.

**When a lot is recalled, the system stops allocation and quarantines the
remaining stock automatically.** That asymmetry is deliberate: stock that may be
unsafe should stop being sold the moment somebody with the authority says so, and
requiring a second approval to _stop selling_ would get the risk the wrong way
round.

**It does not contact anyone.** Given the recalled lots it derives the affected
orders and customers — the join that lot tracking exists to make possible — and
then withholds every identity until a named person approves contacting them.
Before approval the console shows counts only: enough to assess scale and brief a
regulator, not enough to reach anybody. The withholding is enforced in the
service, so no route, screen or export gets the identities by asking differently,
and reading the impact is itself recorded on the recall whether or not identities
were disclosed.

Approval requires a separate permission (`RECALL_NOTIFY`, held by compliance
reviewers and deliberately not by `ADMIN` or the warehouse), a second factor, a
written basis, and an acknowledgement typed verbatim rather than ticked. A
checkbox is exactly how someone arrives at this decision by clicking through
screens.

Approving still sends nothing. Phase 5 added transactional email, and recall
notification is deliberately **not** wired to it: dispatch is a further explicit
act, not a consequence of approval. Approving unlocks the affected-customer list
and records who unlocked it and why; reaching those customers remains a manual
act performed by a person who can answer the questions it will produce.

Closing a recall does not put the stock back: closing records that the response
is finished, not that the goods turned out to be fine. Cancelling restores each
lot to the status it held _before_ the recall, and is unavailable once contact
has been approved.

### Customer-written content (built, Phase 5)

A review is **customer speech about a regulated product published on the
business's own website**, which means the business is answerable for it. So no
review is ever visible on the strength of being written: every one is read by a
person, and the state machine has no edge that bypasses one. There is no rating
threshold that auto-approves and no phrase list that auto-rejects.

**The system prompts; it never judges.** Wording that often signals a health
claim — "cured", "treats", a named disease — puts a banner on the moderation
screen carrying the matched terms. It does not reject, does not publish, and
does not change the review's state. A word list cannot tell whether "it cured my
headache" is a disease claim in context, and code that acted on one would be
making a regulatory decision by substring match, failing in the direction nobody
notices.

Every moderation outcome requires written reasoning, **publication included**.
"Why is this live?" is as worth answering as "why was this rejected?", and on a
health product it is the more important of the two. Decisions are append-only.

**Adverse events are recorded independently of the outcome.** A customer
describing harm is a safety signal whether or not their words go on the site, so
the flag is separate from publish/reject rather than a consequence of rejecting.
Escalation hands the decision to compliance and cannot be taken back.

**This system reports nothing to anyone.** Flagging an adverse event records it
and surfaces it in the console. Serious adverse event reporting under DSHEA is a
staffed process outside this platform, and the admin screen says so rather than
letting the flag imply a report was filed.

`verifiedPurchase` is derived from the reviewer's own order line and has no
field on the request. A badge that a client could assert would make "verified"
worth nothing.

### Auto-renewal and cancellation (built, Phase 5)

US auto-renewal statutes — ROSCA federally, and stricter state laws such as
California's ARL — turn several ordinary product decisions into legal ones.

**Cancelling is one button, immediate, and needs no reason.** There is no
retention offer, no required explanation, no waiting period and no phone number.
Each of those is a dark pattern regulators have been explicit about, and none is
enforceable through this API even if a screen tried.

**The price is the one the subscriber agreed to.** Item prices live on the
subscription and are never re-read from the catalogue at renewal. A catalogue
price change does not reach an existing subscription at all. Changing what a
subscriber pays needs their agreement; until that flow exists, the safe
behaviour is to charge the agreed amount.

**A failed renewal stops fulfilment before it stops anything else.** The
subscription moves to `PAST_DUE` — billable, not shippable — and the customer is
told in the same transaction that records the failure. The important sentence is
"nothing will ship": a customer who believes a delivery is on its way will not
act, and it will not arrive.

**Retries are bounded.** When the dunning schedule is exhausted the subscription
is left `UNPAID` and is not tried again.

**No staff member can charge a subscription by hand.** There is one function
that takes a recurring payment, and it is called by the API when a subscription
starts and by the scheduled run. Billing is idempotent per period through a
unique constraint written before the provider is called.

### Discounts (built, Phase 5)

A checkout names a code and never an amount. What the code is worth is
recomputed server-side on every repricing, so an amount cannot be supplied by a
client or go stale against a basket that changed. Percentages round **down** —
rounding a discount up is money given away by arithmetic nobody reviewed.

Redemption limits are enforced by counting redemption rows under a row lock, not
by a counter, so two concurrent checkouts cannot both take the last use. A
per-customer limit is refused unless the code requires a signed-in customer,
because a limit that silently cannot be enforced is worse than no limit.

### Support and health questions (built, Phase 5)

There is no "medical question" topic, and there deliberately never will be one
until a qualified person is available to answer. The storefront shows the
redirect to a doctor or pharmacist **before** the customer types, not after — a
notice that appears afterwards has already collected the health information it
was meant to prevent.

Staff internal notes are excluded in the query that builds the customer's view,
not filtered from a result set afterwards. An internal note also does not notify
the customer: a notification about a note about them would be the same leak by
another route.

### Erasure (built, Phase 5)

Deletion is decided by a named person holding `CUSTOMER_ERASE` — separate from
`CUSTOMER_WRITE`, because editing an account and erasing one are not the same
authority — with a second factor and written reasoning. Nothing is deleted by
asking.

What is removed: contact details, addresses, saved payment tokens, support
conversations, the sign-in, and the customer's name against their reviews.

What is retained, and why:

| Retained                    | Why it cannot be removed on request             |
| --------------------------- | ----------------------------------------------- |
| Orders, payments, refunds   | Tax, accounting and consumer-protection records |
| Which lots the customer got | So a recall can still reach them                |
| Consent history             | The evidence of what was agreed, and when       |
| Audit records               | Who did what to the account                     |

The lot-reservation record is the one worth stating plainly: **a recall
obligation does not lapse because somebody closed their account.** Removing the
link between a customer and the lots they received would mean the business could
not warn them, and the customer is told this before they ask.

Reviews are anonymised rather than deleted, because deleting them would silently
change a published rating other customers rely on. The name comes off; the words
stay.

### Editorial content about products (built, Phase 6)

A blog post that names a product is marketing copy about a regulated product.
An article headlined "how magnesium supports restful sleep" that links to a
magnesium product is making a claim about that product, and the fact that it is
prose in a journal rather than a bullet on a listing is not a distinction a
regulator draws.

So a post that names a product goes through the **same sign-off a listing
does**: `COMPLIANCE_APPROVE`, a second factor, and written reasoning. That
permission is held by compliance reviewers and deliberately not by content
staff, marketing, or `ADMIN` — a writer who could approve their own product
claims is not a gate, it is a formality.

A post that names **no** product publishes on the editor's own authority. This
is a gate on claims about products, not a bureaucracy for every page.

**The product list is declared by the writer, not detected from the prose.** A
pattern match over an article deciding whether it is "about" a product would
fail in the direction nobody notices: the post it missed is the one that
publishes unreviewed claims. A person says what the post is about, and the
reviewer reads the text regardless.

**The approval is bound to the exact text.** The decision records a hash of the
title, body and product list that was read; publishing recomputes it from what
is actually going live and refuses a mismatch — in a database CHECK, so a direct
`UPDATE` cannot get past it either. "A published post has an approval" is
necessary and not sufficient: a post could be approved as a recipe and published
as a disease claim.

Editing a live post writes to a draft, so readers keep seeing the text that was
approved while the unapproved edit waits for review. Decisions are append-only.

Blog posts carry the same FDA disclaimer as product pages, in the same words.

### Analytics and health-adjacent data (built, Phase 6)

**What somebody browses on a supplements site is health-adjacent information
about them.** A record that a named person looked at a menopause supplement, a
fertility supplement or a sleep aid is, in substance, a health inference. The
FTC has brought enforcement actions against health companies for precisely this
kind of data reaching analytics vendors and advertisers, and the fact that the
company called it "analytics" was not a defence.

The measurement system is therefore built so the profile **cannot** be
assembled, rather than merely not being assembled today:

| Property                 | How it is guaranteed                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No identity in analytics | No analytics table has a customer id, user id, email, order id or IP column. A database **event trigger fails any migration** that would add one.                                                                                       |
| No IP address stored     | The address is an input to a salted hash inside one function and is then gone.                                                                                                                                                          |
| No cross-day profile     | Visitor hashes use a salt that rotates every UTC day and is deleted with the events. Two days' hashes for one person are unrelated, and yesterday's cannot be recomputed from an IP by anyone — including someone holding the database. |
| No query strings         | Discarded in full before a path is stored, not filtered. A CHECK refuses a stored path containing `?`.                                                                                                                                  |
| No referrer paths        | Reduced to a host. A CHECK refuses a value containing `/`.                                                                                                                                                                              |
| No fine-grained location | Two-letter country only; a CHECK enforces it. A city on a health site is a small crowd.                                                                                                                                                 |
| No search terms          | `search_performed` records that a search happened, never what was typed. A search box on this site is where somebody types a symptom.                                                                                                   |
| No free-form payload     | The event shape is a closed set of scalars. There is no field personal data could be put in.                                                                                                                                            |
| Short retention          | Raw events, sessions and salts are deleted after 30 days. The surviving rollups are counts.                                                                                                                                             |

**There is no third-party analytics, no pixel, no tag manager and no advertising
identifier on the storefront.** That is not a gap to be filled in later.

**Consent is opt-in, and browser-level signals beat it.** `Sec-GPC: 1` is
honoured as a full opt-out from measurement — stricter than the letter of the
CPRA, and far easier to defend than arguing about whether first-party
measurement counts as "sharing". `DNT: 1` is honoured too, though it is not
binding. A visitor who has not answered the banner has not agreed.

**Conversion is measured without joining a person to their browsing.** An order
carries denormalised campaign labels and no session identifier; conversion rate
is orders-by-channel over sessions-by-channel. That one foreign key would
reconstruct everything above, so it does not exist, and a test asserts the
column is absent.

**Measurement never fails a purchase.** Recording a conversion is wrapped so
that an analytics failure cannot fail a checkout that already took money.

### SEO and generated copy (built, Phase 6)

Mechanical SEO is automated: sitemaps, canonical URLs, redirects on rename,
structured data, and an audit that reports missing titles, missing descriptions,
missing alternative text, duplicate titles and published pages excluded from the
index.

**No copy is generated, anywhere.** Not a meta description, not a title, not
alternative text, not a snippet. A meta description for a supplement is a public
statement about a health product, and a generated one is exactly the fluent,
plausible sentence that ends up making a claim nobody reviewed and no evidence
supports. The audit reports the gap and a person writes the words — and the
admin screen says so, so nobody adds a "generate" button later without meeting
the argument.

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
  URLs, browser storage or error messages. From Phase 6 this is structural for
  analytics rather than a rule to remember: the tables have no identity columns,
  a database trigger refuses to let any be added, and query strings never reach
  storage.
- There is no third-party analytics, advertising pixel or tag manager on the
  storefront, and adding one would defeat every guarantee above.
- Consent history is retained as evidence and is not deleted by the application.

## Records to retain

| Record                       | Retained     | Why                                 |
| ---------------------------- | ------------ | ----------------------------------- |
| Claim approvals and versions | Indefinitely | Substantiation history              |
| Evidence and reviews         | Indefinitely | Substantiation history              |
| Claim versions and decisions | Indefinitely | The exact words that were approved  |
| Batch and lot records        | Per policy   | Traceability, recall scope          |
| Recall actions               | Indefinitely | Regulatory record                   |
| Audit log                    | Per policy   | Who did what, when                  |
| Consent ledger               | Per policy   | Proof of permission                 |
| Review moderation decisions  | Indefinitely | Why customer speech was published   |
| Subscription events          | Per policy   | What a subscriber was charged, when |
| Erasure decisions            | Indefinitely | The response to a legal request     |
| Order and payment records    | Per tax law  | Financial and tax obligations       |

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
- [ ] Review moderators trained on what is and is not a disease claim
- [ ] Auto-renewal disclosures reviewed by counsel against ROSCA and state law
- [ ] Support staff trained to redirect clinical questions rather than answer them
- [ ] Analytics practice reviewed by counsel against state privacy law, including GPC handling
- [ ] Confirmed no third-party tag, pixel or advertising script has been added to the storefront
- [ ] Blog authors and compliance reviewers trained on what makes a post a product claim
