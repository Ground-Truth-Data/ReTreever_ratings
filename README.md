# ReTreever ratings — how a score is computed

This is a **publication, not a package.** It is here so anyone can read exactly
how a ReTreever transparency score and percentile rank are calculated, and
check the arithmetic against their own data.

## What a score is

The score is a measure of reforestation stakeholder transparency. It measures
the disparity between the claimed total trees planted. In other words, its a measure of what's verifiable.

For example, a stakeholder claims to have planted one million trees. How much
publicly available evidence is there? Verifiability in that claim?

- Are there polygons available? Do the polygons contain a meaningful
  concentration of planted trees — for example, 1,200 stems per hectare of tree
  planted? Or is it just a dot on a map - that could mean the
  entire country?
- Are there more data attributes available? How many trees of what species are planted in which
  site? Where did the trees come from?
- Are the other stakeholders listed?
- Is there survey data available?
- When was it planted? Why was it planted? Who planted it? and so on...

Those attributes are weighted based on their value. For example, polygons are
worth a lot more than other attributes.

The totals are summed up per project — "what" — and aggregated per vendor —
"who". Then all those stats are measured against other organizations in the
same stakeholder group. For example, nurseries are compared against each other
to find who is in the top percentile, and who is at the bottom, and the middle,
etc.

A rating of 90 — the 90th percentile — is extremely transparent. Their claims
are greatly verifiable.

An organization with a rating of 10 — the 10th percentile — is opaque. Their
work is unverifiable. They can make any claims they want, but there's little
evidence to show if its true or not, to show the quality of the work, if the
trees survived etc. We have no idea; it's just a claim with no evidence.

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
same set. `score_orgs.ts` computes two: overall, and within stakeholder
category — a small NGO is ranked against small NGOs, not against a government
programme.

`theScore.md` is the long-form methodology; `CLAIM_METHODOLOGY.md` covers how
claims are treated.

## Why you cannot run this as-is

`score_orgs.ts` and `score_projects.ts` read and write ReTreever's production
database through a generated Prisma client that lives in the private parent
repo. Neither the client nor the database ships here, and neither should.

That is deliberate. The point of publishing is that the **method** is
inspectable — the weights, the SQL, the reasoning. Handing out a runnable
copy of our scoring pipeline is a different thing, and not one we are doing.

`scoreMatrix.ts` is the exception: pure data with no imports. Read it directly.

## The database is the source of truth for weights

`SCORE_MATRIX` seeds `ScoreMatrixTable` when it is empty, and after that the
table wins. A weight hand-edited in the database survives; changing the
constant here does not silently re-weight everything.

---

Licensed AGPL-3.0. Ground Truth Data Inc.
