import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { GOLDEN_ORGS, type GoldenOrg, type GoldenOutcome, runGolden, seedGolden } from "./golden.fixture";
import { matrixPoints } from "./scoreMatrix";

// The method's outcomes, pinned: six orgs scored from seeded records with the
// live weights, ranked within the served population, each given its cohort.
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

// Every project offers 82 points under today's schema and weights; the
// comments say what each org lost or kept.
const GOLDEN: Record<GoldenOrg, GoldenOutcome> = {
	// 43/82, no claim: its own cohort, the pre-claim score, tied with unvalidated.
	noClaim: { final: 0.52439, ratio: null, cohort: "unreviewed", percentile: 1, rank: 1, claimKeys: [] },
	// No coordinates: 33/82 × 800/1000.
	validated: { final: 0.321951, ratio: 0.8, cohort: "reviewed", percentile: 1, rank: 1, claimKeys: ["validated-1"] },
	// A `{}` polygon earns nothing: 23/82 × 500/100 capped at 1.
	overClaim: { final: 0.280488, ratio: 1, cohort: "reviewed", percentile: 0.666667, rank: 2, claimKeys: ["overClaim-1"] },
	// Its only claim is unvalidated: no ratio, never full disclosure among the reviewed.
	unvalidated: { final: 0.52439, ratio: null, cohort: "unreviewed", percentile: 1, rank: 1, claimKeys: [] },
	// 38/68 (no crop) × 500/(1000 + 250): the restatement and the latest seedlings claim.
	restated: { final: 0.223529, ratio: 0.4, cohort: "reviewed", percentile: 0.333333, rank: 3, claimKeys: ["restated-2", "restated-5"] },
	// No project: null, unranked, no cohort.
	nothing: { final: null, ratio: null, cohort: null, percentile: null, rank: null, claimKeys: [] },
};

describe("golden: six disputes, settled", () => {
	it("pins every org's score, ratio, cohort, percentile, rank and the claims it summed", async () => {
		expect(await runGolden(t.prisma, matrixPoints())).toEqual(GOLDEN);
	});

	it("a second run over the same rows reproduces the first exactly", async () => {
		const first = await runGolden(t.prisma, matrixPoints(), "golden-1");
		expect(await runGolden(t.prisma, matrixPoints(), "golden-2")).toEqual(first);
	});

	it("one weight moved moves only the orgs whose records carry that field", async () => {
		const before = await runGolden(t.prisma, matrixPoints(), "golden-1");
		const after = await runGolden(t.prisma, new Map([...matrixPoints(), ["cropName", 0]]), "golden-2");

		const moved = GOLDEN_ORGS.filter((o) => before[o].final !== after[o].final);
		expect(moved).toEqual(["noClaim", "validated", "overClaim", "unvalidated"]);
		for (const o of GOLDEN_ORGS) {
			expect(after[o].cohort, o).toBe(before[o].cohort);
			expect(after[o].ratio, o).toBe(before[o].ratio);
			expect(after[o].claimKeys, o).toEqual(before[o].claimKeys);
		}
	});
});
