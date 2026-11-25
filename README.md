# ReTreever ratings — how a rating is computed

This is where ReTreever's transparency scores and ratings are computed. The
scorers are maintained here and run from here, in the open, so anyone can read
exactly how a rating is calculated and check the arithmetic against their own
data. This file describes what the code does today, and says plainly what it
does not do yet.

## What the rating is

The number on a ReTreever rating page is a **percentile**, from 0 to 100: where
the record's score falls among comparable records of the published score run.
Records with the same score share one percentile. Before a run is published, a
page shows no rating.

- **An organization's** is `CUME_DIST()`: the share of its peer group (below)
  scoring at or below it. A rating of 90 means 90% of its peers score the same
  or lower; the top organization of a group is 100. Beside it the run freezes
  its competition rank in the group, 1 the best, and the page says "3rd of 46"
  from the group's size in that run.
- **A project's** is `CUME_DIST()`, rounded to a whole number: the share of
  all scored projects scoring at or below it. The top project is 100 and the
  lowest is never 0.

**Organizations are compared within their primary stakeholder category**
(developers against developers, producers against producers), the role they
hold on most of their projects (`primaryStakeholderCategory`, Tier 8). One with
no category is compared with the others that have none. A category with fewer
than five ranked organizations (`minCategoryGroup` in `scoreConfig.json`) is
too small to compare within: its organizations are placed among every ranked
organization instead, and their page says so ("34th of 86 organizations").

**There is one ranking.** Every organization is labelled by its claims, and
the label never splits the ranking:

- **Reviewed claims.** An organization with at least one current claim of a
  tree count, on a source validated against its latest capture. Its score is
  its weighted mean times its disclosure ratio (below).
- **Claims not yet reviewed.** An organization with no such claim. Its score
  is its weighted mean alone: there is no ratio to apply.

Both are ranked together, in the same category. Because the ratio is at most
1, a reviewed claim can only lower an organization's place; that it has no
reviewed claim is said by its label, not by ranking it apart. A run of
methodology version 1, which ranked each kind only among its own, is neither
published nor served.

The rating page names the score run it was read from. Every run is recorded
(§ Every run is recorded), so a published rating traces back to the code and
weights that made it.

## What is ranked: the score

### A project's score

A project is scored on everything it could have disclosed. Each table below
lists the fields one record offers (`OFFERED`, `projectScore.ts`). Every field
of every record the project has is checked: is it filled? A filled field earns
its points; the score is the points earned over the points offered, from 0 to 1.

**A table with no record still offers one record's worth, and earns none of
it.** A project that published no planting record scores 0 of 16 there; it is
not left out of the sum. So every project is offered at least 126 points, and
missing data costs points.

### What a project is offered

| Table | Fields | Points for one record |
|---|---|---|
| `ProjectTable` | 5 | 5 |
| `LandTable` | 6 | 14 |
| `PolygonTable` | 6 | 25 |
| `CropTable` | 6 | 14 |
| `SpeciesTable` | 5 | 5 |
| `PlantingTable` | 8 | 16 |
| `MiscTable` | 14 | 14 |
| `StakeholderTable` | 1 | 2 |
| `OrganizationTable` | 9 | 9 |
| `ClaimTable` | 4 | 4 |
| `SurveyTable` | 4 | 12 |

A test holds this table equal to `OFFERED` and the weights.

- **Organizations and claims are scored with the project.** Each organization
  a live stakeholder names is scored once, however many of the project's
  stakeholders name it. Each of those organizations' current claims is scored
  once: the same claims the disclosure ratio reads (below), on what the claim
  states (its quantity, hectares, sites and date).
- **A species** is scored once per species the project's crops are linked to.
- **Only what a platform or the organization disclosed is offered.** A column
  ReTreever fills is never a field: a key, a timestamp, a coordinate geocoded
  from an organization's address, a category the claims desk assigns, a
  capture or validation status.

A field counts as filled only when it holds a value. These do not:

- null, blank text, or placeholder text a platform puts in a required box
  (`n/a`, `none`, `unknown`, `tbd`, `-` and the others in `PLACEHOLDER_TEXT`,
  `projectScore.ts`);
- an empty object or list, an invalid date, a number that is not finite;
- a latitude or longitude of exactly 0 (the default, not a place), a size of
  0 or less;
- a `geometry` that is not a real polygon: a point, an empty shape or a ring
  that encloses no area proves no site.

Sources (`SourceTable`) are scored on six baseline fields, 6 points. One
source per kind of link (`urlType`) counts, so a project's hundredth photo
earns what its first did: volume cannot buy a score. The fullest source is
offered all six; each further kind adds only the fields it fills. A project
with no source is offered the six and earns none.

### The weights

`scoreMatrix.ts` is the whole weighting, in one table. An offered field it
does not list is worth 1 point.

| Field | Points |
|---|---|
| `geometry` | 20 |
| `latitude` | 5 |
| `longitude` | 5 |
| `cropName` | 5 |
| `speciesName` | 5 |
| `plantingDt` | 5 |
| `plotCenter` | 5 |
| `radius` | 5 |
| `plantedQty` | 3 |
| `stakeholderCategory` | 2 |
| `pricePerUnit` | 2 |
| `pricePerUnitUSD` | 2 |

A test holds this table equal to `SCORE_MATRIX`.

### An organization's score

Only the organizations the site shows are scored: each one a parent, its
numbers read across the listings under it. A listing on its own carries no
score, and an organization that stops being shown loses its score at the next
run, so no number survives that the site no longer stands behind.

1. **The projects.** Every live project the organization (with every listing
   under it) is a stakeholder in, each counted once. Listings known to be the
   same planting count as one.
2. **The weighted mean.** The mean of those projects' scores, each weighted by
   its points offered, so a project with many records outweighs one with few.
3. **The disclosure ratio**, for the reviewed cohort only: trees documented in
   plantings over trees claimed, **capped at 1**. Per organization and claim
   category only the current claim is read: the latest one no later claim
   replaces or ends. It counts only when its source is validated against the
   source's latest capture; if not, it counts for nothing, and the older claim
   it replaced does not count in its place. A claim of 0 trees claims nothing,
   so the ratio is 1.
4. **The score** is the weighted mean times the ratio. An organization in the
   "claims not yet reviewed" cohort has no ratio, so its score is the weighted
   mean alone.

**Whose trees they are.** A project's plantings belong only to the
organizations that hold an owning role on it: developer, producer or
landowner (`plantingOwnerRoles` in `scoreConfig.json`). A sponsor,
marketplace or research partner is credited with the project's documentation
in its weighted mean, never with its trees. An organization that owns no
plantings has no disclosure ratio whatever it claims (neither 0 nor full
disclosure): it is labelled "claims not yet reviewed" and scored on its
weighted mean alone.

An organization with nothing scored has no score and no rating (null), not a
rating of 0.

## The state words

Each rating carries one of four words, by equal quarters of the percentile:

| State | Rating |
|---|---|
| **Opaque** | 0 to below 25 |
| **Partial** | 25 to below 50 |
| **Open** | 50 to below 75 |
| **Transparent** | 75 to 100 |

**Why quarters.** The rating is a percentile, so published records spread
evenly from 0 to 100 and four equal bands each hold about a quarter of them.
The word says which quarter of the field a record is in, and the cuts follow
from the number of words alone: nobody chose a threshold. The one exception is
a block of tied scores: tied records share one percentile, so a large tie lands
together in one band and can leave a neighbouring band empty. Many projects
share the same score, and on 12 Nov 2026 no project fell in "Open".

The cuts live in one place, `ReTreever_who_what/lib/rating/ratingState.ts`
(`RATING_STATE_FLOORS`), and a test holds this table equal to it.

## What is not built

- **Claims in hectares or sites.** Only claims that state a tree count are
  compared. A claim in hectares or sites is not converted to trees and is not
  counted.
- **Claim review.** "Reviewed" means only that a claim is current and its
  source is validated. No one has judged whether the claim is reforestation,
  conservation or something else, and no state of such a review is read.
- **Peer groups.** An organization's category is the role it holds on most of
  its projects, not a judgement of what it is: one that plants on some projects
  and funds others is compared as whichever it does more.

## Why it runs only inside ReTreever's workspace

`score_projects.ts` and `score_orgs.ts` read and write ReTreever's database
through the Prisma client generated in the private parent repo, and take the
parent's run lock so that only one writer touches the database at a time. Both
are imported through the `$parent` alias, which resolves only when this repo
sits beside its parent in that workspace. Neither the client nor the database
ships here, and neither should.

That is deliberate. The point of publishing is that the **method** is
inspectable — the weights, the SQL, the reasoning — not that a copy of the
pipeline runs anywhere.

`scoreMatrix.ts` is pure data. The pure scoring functions (`projectScore.ts`,
`orgScore.ts`, `subtree.ts`, `scoreRun.ts`) are covered by the `*.test.ts`
files beside them.

## Every run is recorded

`SCORE_MATRIX` in `scoreMatrix.ts` is the live weighting. Each score run
first makes `ScoreMatrixTable` equal to it (`seedScoreMatrix`), so the table
is a mirror for the admin to read and a hand edit there lasts until the next
run. Retuning a weight is a commit.

Each run writes one `ScoreRunTable` row — this repo's commit and whether the
tree was dirty, a hash of the weights and of `scoreConfig.json`, the
methodology version, and the Foundr run whose rows it scored — and freezes
every rating it computed into a snapshot. The public site serves only a run
that finished, whose snapshot re-adds to its scores, and that was published.

---

Licensed AGPL-3.0. Ground Truth Data Inc.
