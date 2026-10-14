import { describe, expect, it } from "vitest";
import { NO_SCORE, orgWhere, propagateDirtyToParents, rankOrgs, scoreOneOrg } from "./orgScore";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Prisma's WHERE over plain rows: `null` matches a null column, `{ in }` a list. */
const matches = (r: Row, where: Where) =>
	Object.entries(where).every(([k, v]) =>
		v === null
			? r[k] == null
			: typeof v === "object" && v && "in" in v
				? (v as { in: unknown[] }).in.includes(r[k])
				: r[k] === v,
	);

const gone = new Date("2026-09-01");
const orgs: Row[] = [
	{ organizationKey: "live-dirty", scoreOrgFlag: true, deletedAt: null },
	{ organizationKey: "live-clean", scoreOrgFlag: false, deletedAt: null },
	{ organizationKey: "gone-dirty", scoreOrgFlag: true, deletedAt: gone },
	{ organizationKey: "gone-clean", scoreOrgFlag: false, deletedAt: gone },
];
const targets = (where: Where) => orgs.filter((r) => matches(r, where)).map((r) => r.organizationKey);

describe("orgWhere", () => {
	it("a dirty run takes live dirty rows, --full every live row, never a soft-deleted one", () => {
		expect(targets(orgWhere(false))).toEqual(["live-dirty"]);
		expect(targets(orgWhere(true))).toEqual(["live-dirty", "live-clean"]);
	});

	it("named orgs are filtered the same way", () => {
		expect(targets(orgWhere(true, ["gone-dirty", "live-clean"]))).toEqual(["live-clean"]);
		expect(targets(orgWhere(false, ["gone-dirty", "live-clean"]))).toEqual([]);
		expect(targets(orgWhere(false, ["live-dirty"]))).toEqual(["live-dirty"]);
	});
});

describe("rankOrgs", () => {
	it("ranks live scored rows only, overall and then by category", async () => {
		const sql: string[] = [];
		const db = {
			$executeRawUnsafe: async (s: string) => {
				sql.push(s);
				return 0;
			},
		} as never;
		await rankOrgs(db);

		expect(sql).toHaveLength(2);
		expect(sql[0]).toMatch(/SET "scoreRankOverall"/);
		expect(sql[1]).toMatch(/PARTITION BY "primaryStakeholderCategory"/);
		for (const s of sql) {
			expect(s).toMatch(/WHERE[^)]*"scoreOrgFinal" IS NOT NULL[^)]*AND "deletedAt" IS NULL/s);
		}
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
		claimTable: {
			aggregate: async ({ where }: { where: Where }) => ({
				_sum: {
					claimQty: t.claims.filter((c) => matches(c, where)).reduce((s, c) => s + (c.claimQty as number), 0) || null,
				},
			}),
		},
		$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?");
			sql.push({ text, values });
			const [ids] = values as [string[]];
			if (text.includes('FROM "ProjectTable"')) {
				const links = t.stakeholders.filter((s) => live(s) && ids.includes(s.organizationKey as string));
				const keys = new Set(links.map((s) => s.projectKey));
				return t.projects
					.filter((p) => live(p) && keys.has(p.projectKey))
					.map(({ projectKey, scoreProject, scorePointsAvailable, scorePointsScored }) => ({
						projectKey,
						scoreProject,
						scorePointsAvailable,
						scorePointsScored,
						via: [...new Set(links.filter((s) => s.projectKey === projectKey).map((s) => s.organizationKey as string))].sort(),
						planted: t.plantings
							.filter((g) => live(g) && g.projectKey === projectKey)
							.reduce((s, g) => s + (g.plantedQty as number), 0),
					}));
			}
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
	return { db: db as never, sql, updates, inputs, order };
}

// A parent over two live listings and one soft-deleted one, a lone org
// beside them. A is a stakeholder in X twice (two scraped rows, one project),
// B in Y, the deleted D in W, the lone Z in V.
const fixture = () => ({
	orgs: [
		{ organizationKey: "P", organizationParentKey: null, isParent: true, deletedAt: null },
		{ organizationKey: "A", organizationParentKey: "P", deletedAt: null },
		{ organizationKey: "B", organizationParentKey: "P", deletedAt: null },
		{ organizationKey: "D", organizationParentKey: "P", deletedAt: gone },
		{ organizationKey: "Z", organizationParentKey: null, deletedAt: null },
	],
	stakeholders: [
		{ organizationKey: "A", projectKey: "X", stakeholderCategory: "developer", deletedAt: null },
		{ organizationKey: "A", projectKey: "X", stakeholderCategory: "developer", deletedAt: null },
		{ organizationKey: "B", projectKey: "Y", stakeholderCategory: "funder", deletedAt: null },
		{ organizationKey: "B", projectKey: "Y", stakeholderCategory: "funder", deletedAt: gone },
		{ organizationKey: "D", projectKey: "W", stakeholderCategory: "funder", deletedAt: null },
		{ organizationKey: "Z", projectKey: "V", stakeholderCategory: "nursery", deletedAt: null },
	],
	projects: [
		{ projectKey: "X", scoreProject: 0.75, scorePointsAvailable: 40, scorePointsScored: 30, deletedAt: null },
		{ projectKey: "Y", scoreProject: 0.25, scorePointsAvailable: 40, scorePointsScored: 10, deletedAt: null },
		{ projectKey: "W", scoreProject: 1, scorePointsAvailable: 50, scorePointsScored: 50, deletedAt: null },
		{ projectKey: "V", scoreProject: null, scorePointsAvailable: null, scorePointsScored: null, deletedAt: null },
	],
	claims: [
		{ organizationKey: "A", claimQty: 600, deletedAt: null },
		{ organizationKey: "B", claimQty: 400, deletedAt: null },
		{ organizationKey: "B", claimQty: 5000, deletedAt: gone },
		{ organizationKey: "D", claimQty: 999, deletedAt: null },
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
		await scoreOneOrg(db, "P");

		const subtree = ["P", "A", "B"];
		expect(sql.map((q) => q.values)).toEqual([[subtree, subtree], [subtree]]);
		for (const q of sql) expect(q.text).toMatch(/"deletedAt" IS NULL/);
		expect(updates).toEqual([
			{
				where: { organizationKey: "P" },
				data: {
					scoreOrgPreClaim: 0.5, // (0.75 + 0.25) / 2
					scorePointsAvailable: 80,
					scorePointsScored: 40,
					scoreSumClaimed: 1000, // A 600 + B 400; D's 999 and B's deleted 5000 are not in the subtree
					scoreSumPlantedQty: 750, // X 500 + Y 250
					scoreSumUndisclosed: 250,
					scoreOrgFinal: 0.375, // 0.5 × 750/1000
					primaryStakeholderCategory: "developer", // A's two rows outvote B's one
					scoreLastUpdatedAt: expect.any(Date),
					scoreOrgFlag: false,
				},
			},
		]);
	});

	it("keeps what it averaged: one input per linked project, replaced whole, stamped with the org's time", async () => {
		const { db, updates, inputs, order } = stubDb(fixture());
		await scoreOneOrg(db, "P");

		const scoredAt = updates[0].data.scoreLastUpdatedAt;
		expect(inputs.deleted).toEqual([{ organizationKey: "P" }]);
		expect(inputs.created).toEqual([
			[
				{ organizationKey: "P", projectKey: "X", viaOrganizationKeys: ["A"], scoreProject: 0.75, scorePointsScored: 30, scorePointsAvailable: 40, plantedQty: 500, scoredAt },
				{ organizationKey: "P", projectKey: "Y", viaOrganizationKeys: ["B"], scoreProject: 0.25, scorePointsScored: 10, scorePointsAvailable: 40, plantedQty: 250, scoredAt },
			],
		]);
		// Written first: a failure before the org's update leaves it flagged to retry, never inputs it did not average.
		expect(order).toEqual(["inputs", "inputs", "org"]);
	});

	it("scores a linked listing nowhere: columns nulled, inputs dropped, flag cleared, no query run", async () => {
		const { db, sql, updates, inputs } = stubDb(fixture());
		await scoreOneOrg(db, "A");

		expect(sql).toEqual([]);
		expect(inputs).toEqual({ deleted: [{ organizationKey: "A" }], created: [] });
		expect(updates).toEqual([
			{
				where: { organizationKey: "A" },
				data: { ...NO_SCORE, scoreLastUpdatedAt: expect.any(Date), scoreOrgFlag: false },
			},
		]);
	});

	it("a lone org is its own subtree; an unscored project adds nothing; an unknown key writes nothing", async () => {
		const { db, updates, inputs } = stubDb(fixture());
		await scoreOneOrg(db, "Z");
		expect(inputs.created[0]).toMatchObject([{ projectKey: "V", scoreProject: null, plantedQty: 0 }]);
		expect(updates[0].data).toMatchObject({
			scoreOrgPreClaim: 0,
			scorePointsAvailable: 0,
			scoreSumClaimed: 0,
			scoreOrgFinal: 0,
			primaryStakeholderCategory: "nursery",
		});

		await scoreOneOrg(db, "nope");
		expect(updates).toHaveLength(1);
	});
});
