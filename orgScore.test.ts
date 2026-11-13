import { describe, expect, it } from "vitest";
import { disclosure, NO_SCORE, orgWhere, PLANTING_OWNER_ROLES, propagateDirtyToParents, rankOrgs, scoreOneOrg, weightedMean } from "./orgScore";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Prisma's WHERE over plain rows: `null` matches a null column, `{ in }` a list, `AND` every clause. */
const matches = (r: Row, where: Where): boolean =>
	Object.entries(where).every(([k, v]) =>
		k === "AND"
			? (v as Where[]).every((w) => matches(r, w))
			: v === null
				? r[k] == null
				: typeof v === "object" && v && "in" in v
					? (v as { in: unknown[] }).in.includes(r[k])
					: r[k] === v,
	);

const gone = new Date("2026-09-01");
const orgs: Row[] = [
	{ organizationKey: "live-dirty", scoreOrgFlag: true, deletedAt: null, isParent: true },
	{ organizationKey: "live-clean", scoreOrgFlag: false, deletedAt: null, isParent: true },
	{ organizationKey: "gone-dirty", scoreOrgFlag: true, deletedAt: gone, isParent: true },
	{ organizationKey: "gone-clean", scoreOrgFlag: false, deletedAt: gone, isParent: true },
	{ organizationKey: "unserved-dirty", scoreOrgFlag: true, deletedAt: null, isParent: null },
];
const served = { isParent: true };
const targets = (where: Where) => orgs.filter((r) => matches(r, where)).map((r) => r.organizationKey);

describe("orgWhere", () => {
	it("a dirty run takes live dirty served rows, --full every live served row, never a soft-deleted or unserved one", () => {
		expect(targets(orgWhere(false, served) as Where)).toEqual(["live-dirty"]);
		expect(targets(orgWhere(true, served) as Where)).toEqual(["live-dirty", "live-clean"]);
	});

	it("named orgs are filtered the same way", () => {
		expect(targets(orgWhere(true, served, ["gone-dirty", "live-clean", "unserved-dirty"]) as Where)).toEqual(["live-clean"]);
		expect(targets(orgWhere(false, served, ["gone-dirty", "live-clean"]) as Where)).toEqual([]);
		expect(targets(orgWhere(false, served, ["live-dirty"]) as Where)).toEqual(["live-dirty"]);
	});

	it("the site's predicate is the run's: a scope that serves everything scores everything live", () => {
		expect(targets(orgWhere(false, { deletedAt: null }) as Where)).toEqual(["live-dirty", "unserved-dirty"]);
	});
});

describe("rankOrgs", () => {
	it("ranks only the keys the site's own predicate serves, within each cohort and category (a small category within the whole cohort), and clears every other row", async () => {
		const asked: unknown[] = [];
		const sql: { text: string; values: unknown[] }[] = [];
		const served = { isParent: true };
		const db = {
			organizationTable: {
				findMany: async (args: unknown) => {
					asked.push(args);
					return [{ organizationKey: "P" }, { organizationKey: "Q" }];
				},
			},
			$executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
				sql.push({ text: strings.join("?"), values });
				return 0;
			},
		} as never;
		await rankOrgs(db, served);

		expect(asked).toEqual([{ where: served, select: { organizationKey: true } }]);
		expect(sql).toHaveLength(1);
		// The minimum, twice (percentile and rank), then the served keys.
		expect(sql[0].values).toEqual([5, 5, ["P", "Q"]]);
		expect(sql[0].text).toMatch(/CUME_DIST\(\) OVER \(PARTITION BY "scoreCohort", COALESCE\("primaryStakeholderCategory", ''\) ORDER BY "scoreOrgFinal"\)/);
		expect(sql[0].text).toMatch(/RANK\(\) OVER \(PARTITION BY "scoreCohort", COALESCE\("primaryStakeholderCategory", ''\) ORDER BY "scoreOrgFinal" DESC\)/);
		expect(sql[0].text).toMatch(/CUME_DIST\(\) OVER \(PARTITION BY "scoreCohort" ORDER BY "scoreOrgFinal"\)/);
		expect(sql[0].text).toMatch(/CASE WHEN n < \? THEN p_all ELSE p_cat END/);
		expect(sql[0].text).toMatch(/LEFT JOIN/);
	});
});

describe("weightedMean", () => {
	it("weights each scored project by its points available; unscored and zero-point projects weigh nothing", () => {
		expect(
			weightedMean([
				{ scoreProject: 1, scorePointsAvailable: 10 },
				{ scoreProject: 0, scorePointsAvailable: 30 },
				{ scoreProject: null, scorePointsAvailable: 99 },
				{ scoreProject: 0.9, scorePointsAvailable: 0 },
			]),
		).toBe(0.25);
	});

	it("is null when nothing has points available: nothing scored is not 0", () => {
		expect(weightedMean([])).toBeNull();
		expect(weightedMean([{ scoreProject: 0, scorePointsAvailable: 0 }, { scoreProject: null, scorePointsAvailable: null }])).toBeNull();
	});
});

describe("disclosure", () => {
	const claim = (claimKey: string, claimQty: number | null) => ({ claimKey, claimQty });

	it("no current claim: the unreviewed cohort, no ratio, nothing summed", () => {
		expect(disclosure(500, [])).toEqual({ cohort: "unreviewed", ratio: null, sumClaimed: null, claimKeys: [] });
	});

	it("a claim with no tree count states nothing to divide by", () => {
		expect(disclosure(500, [claim("h", null)])).toMatchObject({ cohort: "unreviewed", ratio: null });
	});

	it("planted over claimed, capped at 1", () => {
		expect(disclosure(750, [claim("b", 400), claim("a", 600), claim("h", null)])).toEqual({
			cohort: "reviewed",
			ratio: 0.75,
			sumClaimed: 1000,
			claimKeys: ["a", "b"],
		});
		expect(disclosure(1_000_000, [claim("a", 10_000)]).ratio).toBe(1);
	});

	it("an org that owns no plantings has no ratio, its claims counted for nothing", () => {
		expect(disclosure(null, [claim("a", 600)])).toEqual({ cohort: "unreviewed", ratio: null, sumClaimed: null, claimKeys: [] });
	});

	it("a claim of 0 trees hides nothing", () => {
		expect(disclosure(0, [claim("a", 0)])).toMatchObject({ cohort: "reviewed", ratio: 1, sumClaimed: 0 });
	});
});

describe("propagateDirtyToParents", () => {
	it("lifts dirt one level per pass between live rows only, until a pass marks nobody", async () => {
		const sql: string[] = [];
		const marked = [2, 1, 0];
		const db = {
			$executeRaw: async (strings: TemplateStringsArray) => {
				sql.push(strings.join(""));
				return marked[sql.length - 1];
			},
		} as never;

		expect(await propagateDirtyToParents(db)).toBe(3);
		expect(sql).toHaveLength(3);
		for (const s of sql) {
			expect(s).toMatch(/c\."scoreOrgFlag" = true/);
			expect(s).toMatch(/c\."deletedAt" IS NULL/);
			expect(s).toMatch(/p\."deletedAt" IS NULL/);
		}
	});
});

/** Enough of the delegates scoreOneOrg touches, over plain rows. The two
 * raw queries are tagged templates, dispatched by their text and answered
 * from the same rows the way the SQL would; every text and its parameters
 * are kept for the test to read. */
function stubDb(t: { orgs: Row[]; stakeholders: Row[]; projects: Row[]; claims: Row[]; plantings: Row[] }) {
	const sql: { text: string; values: unknown[] }[] = [];
	const updates: { where: Where; data: Row }[] = [];
	const inputs: { deleted: Where[]; created: Row[][] } = { deleted: [], created: [] };
	const claimInputs: { deleted: Where[]; created: Row[][] } = { deleted: [], created: [] };
	const order: string[] = [];
	const live = (r: Row) => r.deletedAt == null;
	const db = {
		orgScoreInputTable: {
			deleteMany: async ({ where }: { where: Where }) => {
				inputs.deleted.push(where);
				order.push("inputs");
				return { count: 0 };
			},
			createMany: async ({ data }: { data: Row[] }) => {
				inputs.created.push(data);
				order.push("inputs");
				return { count: data.length };
			},
		},
		organizationTable: {
			findUnique: async ({ where }: { where: { organizationKey: string } }) =>
				t.orgs.find((o) => o.organizationKey === where.organizationKey) ?? null,
			findMany: async ({ where }: { where: Where }) => t.orgs.filter((o) => matches(o, where)),
			update: async (args: { where: { organizationKey: string }; data: Row }) => {
				updates.push(args);
				order.push("org");
				const row = t.orgs.find((o) => o.organizationKey === args.where.organizationKey);
				if (row) Object.assign(row, args.data);
				return row ?? {};
			},
		},
		scoreClaimInputTable: {
			deleteMany: async ({ where }: { where: Where }) => {
				claimInputs.deleted.push(where);
				order.push("claims");
				return { count: 0 };
			},
			createMany: async ({ data }: { data: Row[] }) => {
				claimInputs.created.push(data);
				order.push("claims");
				return { count: data.length };
			},
		},
		$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?");
			sql.push({ text, values });
			const [ids] = values as [string[]];
			// Supersession and recency are the SQL's; the golden suite runs it. Here: live and validated.
			if (text.includes('FROM "ClaimTable"'))
				return t.claims
					.filter((c) => live(c) && c.validated && ids.includes(c.organizationKey as string))
					.map(({ claimKey, claimQty }) => ({ claimKey, claimQty }));
			if (text.includes('FROM "ProjectTable"')) {
				const links = t.stakeholders.filter((s) => live(s) && ids.includes(s.organizationKey as string));
				const keys = new Set(links.map((s) => s.projectKey));
				return t.projects
					.filter((p) => live(p) && keys.has(p.projectKey))
					.map(({ projectKey, scoreProject, scorePointsAvailable, scorePointsScored }) => {
						const here = links.filter((s) => s.projectKey === projectKey);
						const owns = here.some((s) => PLANTING_OWNER_ROLES.includes(s.stakeholderCategory as string));
						return {
							projectKey,
							scoreProject,
							scorePointsAvailable,
							scorePointsScored,
							via: [...new Set(here.map((s) => s.organizationKey as string))].sort(),
							owns,
							planted: owns
								? t.plantings.filter((g) => live(g) && g.projectKey === projectKey).reduce((s, g) => s + (g.plantedQty as number), 0)
								: 0,
						};
					});
			}
			if (text.includes('FROM "LinkCandidateTable"')) return [];
			if (text.includes('FROM "StakeholderTable"')) {
				const counts = new Map<string, number>();
				for (const s of t.stakeholders) {
					if (!live(s) || !ids.includes(s.organizationKey as string) || !s.stakeholderCategory) continue;
					const c = s.stakeholderCategory as string;
					counts.set(c, (counts.get(c) ?? 0) + 1);
				}
				const [top] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
				return top ? [{ stakeholderCategory: top[0] }] : [];
			}
			throw new Error(`unexpected query: ${text}`);
		},
	};
	return { db: db as never, sql, updates, inputs, claimInputs, order };
}

// A parent over two live listings and one soft-deleted one, a lone org
// beside them. A develops X (two scraped rows, one project), B produces Y,
// the deleted D sponsors W, the lone Z is a nursery on V.
const fixture = () => ({
	orgs: [
		{ organizationKey: "P", organizationParentKey: null, isParent: true, deletedAt: null },
		{ organizationKey: "A", organizationParentKey: "P", deletedAt: null },
		{ organizationKey: "B", organizationParentKey: "P", deletedAt: null },
		{ organizationKey: "D", organizationParentKey: "P", deletedAt: gone },
		{ organizationKey: "Z", organizationParentKey: null, deletedAt: null },
	],
	stakeholders: [
		{ organizationKey: "A", projectKey: "X", stakeholderCategory: "developer_ish", deletedAt: null },
		{ organizationKey: "A", projectKey: "X", stakeholderCategory: "developer_ish", deletedAt: null },
		{ organizationKey: "B", projectKey: "Y", stakeholderCategory: "producer_ish", deletedAt: null },
		{ organizationKey: "B", projectKey: "Y", stakeholderCategory: "producer_ish", deletedAt: gone },
		{ organizationKey: "D", projectKey: "W", stakeholderCategory: "sponsor_ish", deletedAt: null },
		{ organizationKey: "Z", projectKey: "V", stakeholderCategory: "nursery", deletedAt: null },
	],
	projects: [
		{ projectKey: "X", scoreProject: 0.75, scorePointsAvailable: 40, scorePointsScored: 30, deletedAt: null },
		{ projectKey: "Y", scoreProject: 0.25, scorePointsAvailable: 120, scorePointsScored: 30, deletedAt: null },
		{ projectKey: "W", scoreProject: 1, scorePointsAvailable: 50, scorePointsScored: 50, deletedAt: null },
		{ projectKey: "V", scoreProject: null, scorePointsAvailable: null, scorePointsScored: null, deletedAt: null },
	],
	claims: [
		{ claimKey: "a1", organizationKey: "A", claimQty: 600, validated: true, deletedAt: null },
		{ claimKey: "b1", organizationKey: "B", claimQty: 400, validated: true, deletedAt: null },
		{ claimKey: "b2", organizationKey: "B", claimQty: 5000, validated: true, deletedAt: gone },
		{ claimKey: "b3", organizationKey: "B", claimQty: 7000, validated: false, deletedAt: null },
		{ claimKey: "d1", organizationKey: "D", claimQty: 999, validated: true, deletedAt: null },
	],
	plantings: [
		{ projectKey: "X", plantedQty: 500, deletedAt: null },
		{ projectKey: "Y", plantedQty: 250, deletedAt: null },
		{ projectKey: "Y", plantedQty: 9000, deletedAt: gone },
		{ projectKey: "W", plantedQty: 50, deletedAt: null },
	],
});

describe("scoreOneOrg", () => {
	it("scores a parent over its live subtree: projects once each, claims against their plantings, the modal category", async () => {
		const { db, sql, updates } = stubDb(fixture());
		await scoreOneOrg(db, "P", "run-1");

		const subtree = ["P", "A", "B"];
		expect(sql.map((q) => q.values)).toEqual([[subtree, subtree, PLANTING_OWNER_ROLES, subtree], [], [subtree], [subtree]]);
		for (const q of [sql[0], sql[2], sql[3]]) expect(q.text).toMatch(/"deletedAt" IS NULL/);
		expect(sql[2].text).toMatch(/"isValidated" IS TRUE/);
		expect(sql[2].text).toMatch(/"validatedManifestSha" IS NOT DISTINCT FROM s\."captureManifestSha"/);
		expect(sql[2].text).toMatch(/NOT EXISTS \(SELECT 1 FROM "ClaimTable" r WHERE r\."supersedesClaimKey" = c\."claimKey"\)/);
		expect(updates).toEqual([
			{
				where: { organizationKey: "P" },
				data: {
					scoreOrgPreClaim: 0.375, // (0.75×40 + 0.25×120) / 160
					scorePointsAvailable: 160,
					scorePointsScored: 60,
					scoreSumClaimed: 1000, // A 600 + B 400; D's 999 is not in the subtree, B's deleted 5000 and unvalidated 7000 don't count
					scoreSumPlantedQty: 750, // X 500 + Y 250
					scoreSumUndisclosed: 250,
					scoreOrgFinal: 0.28125, // 0.375 × 750/1000
					scoreRatioDisclosure: 0.75,
					scoreCohort: "reviewed",
					primaryStakeholderCategory: "developer_ish", // A's two rows outvote B's one
					scoreLastUpdatedAt: expect.any(Date),
					scoreOrgFlag: false,
				},
			},
		]);
	});

	it("keeps what it averaged and summed: one input per linked project, the claim keys under the run", async () => {
		const { db, updates, inputs, claimInputs, order } = stubDb(fixture());
		await scoreOneOrg(db, "P", "run-1");

		const scoredAt = updates[0].data.scoreLastUpdatedAt;
		expect(inputs.deleted).toEqual([{ organizationKey: "P" }]);
		expect(inputs.created).toEqual([
			[
				{ organizationKey: "P", projectKey: "X", viaOrganizationKeys: ["A"], scoreProject: 0.75, scorePointsScored: 30, scorePointsAvailable: 40, plantedQty: 500, scoredAt, scoreRunId: "run-1" },
				{ organizationKey: "P", projectKey: "Y", viaOrganizationKeys: ["B"], scoreProject: 0.25, scorePointsScored: 30, scorePointsAvailable: 120, plantedQty: 250, scoredAt, scoreRunId: "run-1" },
			],
		]);
		expect(claimInputs).toEqual({
			deleted: [{ scoreRunId: "run-1", organizationKey: "P" }],
			created: [[{ scoreRunId: "run-1", organizationKey: "P", claimKey: "a1" }, { scoreRunId: "run-1", organizationKey: "P", claimKey: "b1" }]],
		});
		// Written first: a failure before the org's update leaves it flagged to retry, never inputs it did not average.
		expect(order).toEqual(["claims", "claims", "inputs", "inputs", "org"]);
	});

	it("scores a linked listing nowhere: columns nulled, inputs dropped, flag cleared, no query run", async () => {
		const { db, sql, updates, inputs } = stubDb(fixture());
		await scoreOneOrg(db, "A", "run-1");

		expect(sql).toEqual([]);
		expect(inputs).toEqual({ deleted: [{ organizationKey: "A" }], created: [] });
		expect(updates).toEqual([
			{
				where: { organizationKey: "A" },
				data: { ...NO_SCORE, scoreLastUpdatedAt: expect.any(Date), scoreOrgFlag: false },
			},
		]);
	});

	it("a lone org is its own subtree; nothing scored is null, unranked and asks for no claims; an unknown key writes nothing", async () => {
		const { db, sql, updates, inputs, claimInputs } = stubDb(fixture());
		await scoreOneOrg(db, "Z", "run-1");
		expect(inputs.created[0]).toMatchObject([{ projectKey: "V", scoreProject: null, plantedQty: 0 }]);
		expect(updates[0].data).toMatchObject({
			scoreOrgPreClaim: null,
			scorePointsAvailable: 0,
			scoreSumClaimed: null,
			scoreSumUndisclosed: null,
			scoreOrgFinal: null,
			scoreRatioDisclosure: null,
			scoreCohort: null,
			primaryStakeholderCategory: "nursery",
		});
		expect(sql.some((q) => q.text.includes('FROM "ClaimTable"'))).toBe(false);
		expect(claimInputs.created).toEqual([]);

		await scoreOneOrg(db, "nope", "run-1");
		expect(updates).toHaveLength(1);
	});

	// RT-0025 lands with RT-0028: dropping unvalidated claims must not hand
	// the org full disclosure among orgs whose claims were reviewed.
	it("an org whose claims are all unvalidated is unreviewed with no ratio, never full disclosure", async () => {
		const f = fixture();
		for (const c of f.claims) c.validated = false;
		const { db, updates } = stubDb(f);
		await scoreOneOrg(db, "P", "run-1");
		expect(updates[0].data).toMatchObject({
			scoreOrgPreClaim: 0.375,
			scoreOrgFinal: 0.375,
			scoreRatioDisclosure: null,
			scoreCohort: "unreviewed",
			scoreSumClaimed: null,
		});
	});

	it("an over-claim is capped: the ratio never passes 1", async () => {
		const f = fixture();
		f.claims = [{ claimKey: "a1", organizationKey: "A", claimQty: 10, validated: true, deletedAt: null }];
		const { db, updates } = stubDb(f);
		await scoreOneOrg(db, "P", "run-1");
		expect(updates[0].data).toMatchObject({ scoreRatioDisclosure: 1, scoreOrgFinal: 0.375, scoreSumUndisclosed: -740 });
	});

	it("counts a project's plantings only where the subtree holds an owning role: a sponsor's project stays in the mean", async () => {
		const f = fixture();
		for (const s of f.stakeholders) if (s.organizationKey === "B") s.stakeholderCategory = "sponsor_ish";
		const { db, updates, inputs } = stubDb(f);
		await scoreOneOrg(db, "P", "run-1");
		expect(inputs.created[0]).toMatchObject([{ projectKey: "X", plantedQty: 500 }, { projectKey: "Y", plantedQty: 0 }]);
		expect(updates[0].data).toMatchObject({
			scoreOrgPreClaim: 0.375,
			scoreSumPlantedQty: 500,
			scoreSumClaimed: 1000,
			scoreRatioDisclosure: 0.5,
			scoreOrgFinal: 0.1875,
			scoreCohort: "reviewed",
		});
	});

	it("an org that owns no plantings has no ratio, whatever it claims: never 0, never full disclosure", async () => {
		const f = fixture();
		for (const s of f.stakeholders) s.stakeholderCategory = "sponsor_ish";
		const { db, updates, claimInputs } = stubDb(f);
		await scoreOneOrg(db, "P", "run-1");
		expect(updates[0].data).toMatchObject({
			scoreOrgPreClaim: 0.375,
			scoreOrgFinal: 0.375,
			scoreSumPlantedQty: 0,
			scoreSumClaimed: null,
			scoreSumUndisclosed: null,
			scoreRatioDisclosure: null,
			scoreCohort: "unreviewed",
		});
		expect(claimInputs.created).toEqual([]);
	});
});
