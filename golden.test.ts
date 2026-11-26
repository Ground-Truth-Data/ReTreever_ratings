import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { GOLDEN_ORGS, type GoldenOrg, type GoldenOutcome, runGolden, seedGolden } from "./golden.fixture";
import { matrixPoints } from "./scoreMatrix";

// The method's outcomes, pinned: eight orgs scored from seeded records with the
// live weights, ranked within the served population, each labelled with its cohort.
// A change to the method or a weight moves a row here, and the diff says which.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
});
afterAll(() => t.close());
beforeEach(async () => {
	await t.reset();
	vi.spyOn(console, "log").mockImplementation(() => {});
	await seedGolden(t.prisma);
});

// Every project offers 1,260 points under today's schema and weights: 820
// over the tables it has records in, 310 over the three it has none in (impact,
// survey plots, species), 90 for its organization and 40 for one claim, made or
// not. A second current claim offers 40 more, a second organization 90 and its
// stakeholder row 20. An organization earns its name, a claim its quantity and
// its date when it has one. The comments say what each org lost or kept.
// Reviewed and unreviewed rank together. Six orgs are developers
// (the developer by its role on the co-funded project), over the minimum of
// five, so they rank among themselves; by final, best first: unvalidated
// (.357143, its description at the cap), noClaim (.35, a tenth of it),
// validated, overClaim, restated, developer, and CUME_DIST is the share of the
// six at or below: 6, 5, 4, 3, 2, 1 sixths. The sponsor is alone in its
// category, so it ranks among all seven ranked orgs: only unvalidated and
// noClaim score above it (rank 3), and it and the four reviewed developers are
// at or below it, 5/7.
const GOLDEN: Record<GoldenOrg, GoldenOutcome> = {
	// 441/1260, no claim: the pre-claim score; 31 words of the description's 310 earn 1 of its 10.
	noClaim: { final: 0.35, ratio: null, cohort: "unreviewed", percentile: 0.833333, rank: 2, claimKeys: [] },
	// No coordinates, a claim's quantity: 350/1260 × 800/1000.
	validated: { final: 0.222222, ratio: 0.8, cohort: "reviewed", percentile: 0.666667, rank: 3, claimKeys: ["validated-1"] },
	// A `{}` polygon earns nothing: 250/1260 × 500/100 capped at 1.
	overClaim: { final: 0.198413, ratio: 1, cohort: "reviewed", percentile: 0.5, rank: 4, claimKeys: ["overClaim-1"] },
	// Its only claim is unvalidated, so not current: no ratio, no claim point, never full disclosure among the reviewed.
	// 450/1260: the same records as noClaim, and a description at the cap.
	unvalidated: { final: 0.357143, ratio: null, cohort: "unreviewed", percentile: 1, rank: 1, claimKeys: [] },
	// 430/1300 (no crop: 0 of its 140; two current claims, each quantity and date) × 500/(1000 + 250): the
	// restatement and the latest seedlings claim.
	restated: { final: 0.132308, ratio: 0.4, cohort: "reviewed", percentile: 0.333333, rank: 5, claimKeys: ["restated-2", "restated-5"] },
	// No project: null, unranked, no cohort.
	nothing: { final: null, ratio: null, cohort: null, percentile: null, rank: null, claimKeys: [] },
	// Funds the co-funded project and claims 6000 of its trees, owns none of
	// them: no ratio, its claim summed nowhere, its mean 390/1410 kept whole. The
	// only sponsor, so it ranks among all seven, third.
	sponsor: { final: 0.276596, ratio: null, cohort: "unreviewed", percentile: 0.714286, rank: 3, claimKeys: [] },
	// Develops it, so owns its 600 trees: 390/1410 × 600/1500.
	developer: { final: 0.110638, ratio: 0.4, cohort: "reviewed", percentile: 0.166667, rank: 6, claimKeys: ["developer-1"] },
};

describe("golden: eight disputes, settled", () => {
	it("pins every org's score, ratio, cohort, percentile, rank and the claims it summed", async () => {
		expect(await runGolden(t.prisma, matrixPoints())).toEqual(GOLDEN);
	});

	it("a second run over the same rows reproduces the first exactly", async () => {
		const first = await runGolden(t.prisma, matrixPoints(), "golden-1");
		expect(await runGolden(t.prisma, matrixPoints(), "golden-2")).toEqual(first);
	});

	it("one weight moved moves every org with a project: each is offered that field, crop or no crop", async () => {
		const before = await runGolden(t.prisma, matrixPoints(), "golden-1");
		const after = await runGolden(t.prisma, new Map([...matrixPoints(), ["cropName", 0]]), "golden-2");

		const moved = GOLDEN_ORGS.filter((o) => before[o].final !== after[o].final);
		expect(moved).toEqual(["noClaim", "validated", "overClaim", "unvalidated", "restated", "sponsor", "developer"]);
		for (const o of GOLDEN_ORGS) {
			expect(after[o].cohort, o).toBe(before[o].cohort);
			expect(after[o].ratio, o).toBe(before[o].ratio);
			expect(after[o].claimKeys, o).toEqual(before[o].claimKeys);
		}
	});
});
