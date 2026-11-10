# ReTreever ratings — how a score is computed

This is where ReTreever's transparency scores and percentile ranks are
computed: the scorers are maintained here and run from here, in the open, so
anyone can read exactly how a score is calculated and check the arithmetic
against their own data.

## What a score is

The score is a measure of reforestation stakeholder transparency — the gap
between what an organization claims and what an outside reader can actually
verify.

A stakeholder claims to have planted one million trees. How much publicly
available evidence is there?

- Are there polygons? Do they contain a meaningful concentration of planted
  trees — say 1,200 stems per hectare — or is it a single dot on a map that
  could mean the entire country?
- What other attributes are published? How many trees of what species, on which
  site? Where did the trees come from?
- Are the other stakeholders listed? Is there survey data?
- When was it planted, why, and by whom?

Those attributes are weighted by value — polygons are worth far more than the
rest. Totals are summed per project ("what") and aggregated per vendor ("who"),
then measured against other organizations in the same stakeholder group, so
nurseries are compared against nurseries.

A rating of 90 — the 90th percentile — is extremely transparent; the claims are
greatly verifiable. A rating of 10 is opaque: the work is unverifiable, and the
claim stands with little evidence of whether it is true, whether the quality was
there, or whether the trees survived.

`scoreMatrix.ts` is the whole weighting, in one table. Geometry — a real
polygon proving the site physically exists — is worth 20 points. GPS
coordinates, species identification and planting date are 5 each. Quantified
impact (how many were planted) is 3. Classification and price data are 2.

A project's score is the points it earns over the points available. An
organization's score aggregates its projects.

## What a rank is

Ranks are **percentiles computed in Postgres**, not in JavaScript:

```sql
ROUND(PERCENT_RANK() OVER (ORDER BY "scoreProject") * 100)::int
```

So a rank of 90 means the project scores higher than 90% of the others in the
same set. `orgScore.ts` (run by `score_orgs.ts`) computes two over live
orgs: overall, and within stakeholder category — a small NGO is ranked
against small NGOs, not against a government programme.

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

`scoreMatrix.ts` is the exception: pure data with no imports. Read it directly.
The pure scoring functions (`projectScore.ts`, `orgScore.ts`, `subtree.ts`,
`scoreRun.ts`) are covered by the `*.test.ts` files beside them, which run
against stubs with no database.

## Git is the source of truth for weights, and every run is recorded

`SCORE_MATRIX` in `scoreMatrix.ts` is the live weighting. Each score run
first makes `ScoreMatrixTable` equal to it (`seedScoreMatrix`), so the table
is a mirror for the admin to read and a hand edit there lasts until the next
run. Retuning a weight is a commit.

Each run then writes one `ScoreRunTable` row — this repo's commit and whether
the tree was dirty, a hash of the weights and of `scoreConfig.json`, the
methodology version, and the Foundr run whose rows it scored — and stamps
that row's id on every by-field and org-input row it writes. A published
score traces back to the code and weights that made it, and scoring the same
inputs under the same files reproduces it (`scoreRunRow.test.ts`).

---

Licensed AGPL-3.0. Ground Truth Data Inc.
