import { describe, expect, it } from "vitest";
import { fieldPoints, fieldScores, scoreOneProject } from "./projectScore";

const points = fieldPoints(new Map([["geometry", 20]]), 1);

describe("fieldPoints", () => {
	it("weights from the matrix, the default for any other field, 0 for a system field", () => {
		expect(points("geometry")).toBe(20);
		expect(points("hectares")).toBe(1);
		expect(points("isQualityPass")).toBe(1);
		for (const f of ["projectKey", "createdAt", "editedBy", "platformId", "parentTable", "parentKey", "randomJson"])
			expect(points(f)).toBe(0);
	});

	it("a row's own score columns and serving flags are worth 0", () => {
		for (const f of [
			"scoreProject",
			"scorePointsAvailable",
			"scorePointsScored",
			"scoreProjectRank",
			"scoreProjectFlag",
			"scoreHistoryLog",
			"scoreLastUpdatedAt",
			"isPublic",
			"isParent",
		])
			expect(points(f)).toBe(0);
	});
});

describe("fieldScores", () => {
	it("one row per scoreable field per record, named Table.field; populated is not null and not empty", () => {
		const rows = fieldScores(
			"p",
			{
				LandTable: [
					{ landKey: "l1", hectares: 3, geometry: null, landName: "" },
					{ landKey: "l2", hectares: null, geometry: "{}", landName: "x" },
				],
			},
			points,
		);
		expect(rows.map((r) => `${r.fieldName}=${r.pointsAwarded}/${r.pointsAvailable}`)).toEqual([
			"LandTable.hectares=1/1",
			"LandTable.geometry=0/20",
			"LandTable.landName=0/1",
			"LandTable.hectares=0/1",
			"LandTable.geometry=20/20",
			"LandTable.landName=1/1",
		]);
		expect(rows.every((r) => r.projectKey === "p")).toBe(true);
		expect(new Set(rows.map((r) => r.granularProjectScoreId)).size).toBe(6);
	});
});

type Row = Record<string, unknown> & { projectKey: string };
type Where = Record<string, unknown>;
type Include = Record<string, boolean | { where: Where }>;

const matches = (r: Record<string, unknown>, where: Where) =>
	Object.entries(where).every(([k, v]) =>
		v === null
			? r[k] == null
			: typeof v === "object" && v && "in" in v
				? (v as { in: unknown[] }).in.includes(r[k])
				: r[k] === v,
	);

/** Enough of the delegates scoreOneProject touches, over rows keyed by
 * projectKey; records what it asks and writes. An update lands on the row,
 * as it would in Postgres, so a second score reads what the first wrote. */
function stubDb(tables: Record<string, Row[]>) {
	const updates: { where: Where; data: Record<string, unknown> }[] = [];
	const deleted: Where[] = [];
	const created: { fieldName: string; pointsAwarded: number; pointsAvailable: number }[][] = [];
	const orgMarks: { where: Where; data: Record<string, unknown> }[] = [];
	const order: string[] = [];
	const asked: Record<string, Where[]> = {};
	const included: Record<string, Include[]> = {};
	const delegate = (name: string) => ({
		findMany: async ({ where, include }: { where: Where; include?: Include }) => {
			(asked[name] ??= []).push(where);
			if (include) (included[name] ??= []).push(include);
			return (tables[name] ?? [])
				.filter((r) => matches(r, where))
				.map((r) => {
					const out: Record<string, unknown> = { ...r };
					for (const [rel, spec] of Object.entries(include ?? {})) {
						const rows = out[rel];
						if (typeof spec === "object" && Array.isArray(rows))
							out[rel] = rows.filter((c) => matches(c, spec.where));
					}
					return out;
				});
		},
	});
	const db = {
		projectTable: {
			...delegate("projectTable"),
			findUnique: async ({ where }: { where: { projectKey: string } }) => {
				const row = tables.projectTable.find((r) => r.projectKey === where.projectKey);
				return row ? { ...row } : null;
			},
			update: async (args: { where: { projectKey: string }; data: Record<string, unknown> }) => {
				updates.push(args);
				order.push("project");
				const row = tables.projectTable.find((r) => r.projectKey === args.where.projectKey);
				if (row) Object.assign(row, args.data);
				return row ? { ...row } : {};
			},
		},
		landTable: delegate("landTable"),
		cropTable: delegate("cropTable"),
		plantingTable: delegate("plantingTable"),
		miscTable: delegate("miscTable"),
		stakeholderTable: delegate("stakeholderTable"),
		organizationTable: {
			updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
				orgMarks.push(args);
				order.push("orgs");
				return { count: 0 };
			},
		},
		surveyTable: delegate("surveyTable"),
		projectScoreByFieldTable: {
			deleteMany: async ({ where }: { where: Where }) => {
				deleted.push(where);
				return { count: 0 };
			},
			createMany: async ({ data }: { data: typeof created[number] }) => {
				created.push(data);
				return { count: data.length };
			},
		},
	};
	return { db: db as never, updates, deleted, created, asked, included, orgMarks, order };
}

/** A row as the upsert leaves it: never scored, flagged. */
const unscored = {
	scoreProject: null,
	scorePointsAvailable: null,
	scorePointsScored: null,
	scoreProjectRank: null,
	scoreProjectFlag: true,
	scoreHistoryLog: null,
	isPublic: false,
};
const gone = new Date("2026-09-01");

// Four projects, each 1:1 with a platform's record: A and B are the same
// project as two platforms published it, L is a third, E was scraped with no
// records at all. Under A a soft-deleted land, under l1 a soft-deleted
// polygon: records that no longer exist.
const fixture = (): Record<string, Row[]> => ({
	projectTable: [
		{ projectKey: "A", projectName: "Mangrove (a)", ...unscored },
		{ projectKey: "B", projectName: "Mangrove (b)", ...unscored },
		{ projectKey: "L", projectName: "Lone", ...unscored },
		{ projectKey: "E", projectName: "Empty", ...unscored },
	],
	landTable: [
		{
			landKey: "l1",
			projectKey: "A",
			hectares: 3,
			geometry: "{}",
			PolygonTable: [
				{ polygonKey: "g1", landKey: "l1", geometry: "{}" },
				{ polygonKey: "g2", landKey: "l1", geometry: "{}", deletedAt: gone },
			],
		},
		{ landKey: "l2", projectKey: "A", hectares: null, geometry: null, PolygonTable: [] },
		{ landKey: "l3", projectKey: "B", hectares: 1, geometry: null, PolygonTable: [] },
		{ landKey: "l4", projectKey: "L", hectares: 2, geometry: null, PolygonTable: [] },
		{ landKey: "l5", projectKey: "A", hectares: 9, geometry: "{}", deletedAt: gone, PolygonTable: [] },
	],
	cropTable: [{ cropKey: "c1", projectKey: "B", cropName: "Rhizophora" }],
});

const CHILD_TABLES = ["landTable", "cropTable", "plantingTable", "miscTable", "stakeholderTable", "surveyTable"];

const byTable = (rows: { fieldName: string; pointsAwarded: number; pointsAvailable: number }[]) => {
	const out: Record<string, string> = {};
	for (const r of rows) {
		const t = r.fieldName.split(".")[0];
		const [n, s, a] = (out[t] ?? "0 0/0").replace("/", " ").split(" ").map(Number);
		out[t] = `${n + 1} ${s + r.pointsAwarded}/${a + r.pointsAvailable}`;
	}
	return out;
};

describe("scoreOneProject", () => {
	it("scores a project over its own row and its own live records", async () => {
		const { db, updates, deleted, created, asked } = stubDb(fixture());
		await scoreOneProject(db, "A", points);

		// records: fields scored/available
		expect(byTable(created[0])).toEqual({
			ProjectTable: "1 1/1", // projectName — keys, stamps, the score columns and both flags are system fields
			LandTable: "4 21/42", // l1 3+20, l2 0 — the PolygonTable array is not a field
			PolygonTable: "1 20/20",
		});
		expect(asked.landTable).toEqual([{ projectKey: { in: ["A"] }, deletedAt: null }]);
		expect(deleted).toEqual([{ projectKey: "A" }]);
		expect(updates).toEqual([
			{
				where: { projectKey: "A" },
				data: {
					scoreProject: 42 / 63,
					scorePointsAvailable: 63,
					scorePointsScored: 42,
					scoreLastUpdatedAt: expect.any(Date),
					scoreProjectFlag: false,
				},
			},
		]);
	});

	// The whole point of 1:1: the same project on two platforms is two rows, and
	// neither one's score may borrow the other's records.
	it("takes nothing from the other platform's row for the same project", async () => {
		const { db, updates, created, asked } = stubDb(fixture());
		await scoreOneProject(db, "B", points);

		expect(byTable(created[0])).toEqual({
			ProjectTable: "1 1/1",
			LandTable: "2 1/21",
			CropTable: "1 1/1",
		});
		expect(asked.landTable).toEqual([{ projectKey: { in: ["B"] }, deletedAt: null }]);
		expect(updates[0].data).toMatchObject({ scorePointsAvailable: 23, scorePointsScored: 3 });
	});

	// A walk over ProjectTable is what a hierarchy needed; there is none, so the
	// scorer reads the one row by key and never lists the table.
	it("never reads a second project row", async () => {
		const { db, asked } = stubDb(fixture());
		await scoreOneProject(db, "A", points);
		expect(asked.projectTable).toBeUndefined();
	});

	it("counts no soft-deleted record: every child query is live-only, and so is a land's polygons", async () => {
		const { db, created, asked, included } = stubDb(fixture());
		await scoreOneProject(db, "A", points);

		for (const t of CHILD_TABLES)
			expect(asked[t], t).toEqual([{ projectKey: { in: ["A"] }, deletedAt: null }]);
		expect(included.landTable).toEqual([{ PolygonTable: { where: { deletedAt: null } } }]);
		// l5 (9 ha, a polygon) and g2 would have been 2 more land fields and 1 more polygon field
		expect(byTable(created[0]).LandTable).toBe("4 21/42");
		expect(byTable(created[0]).PolygonTable).toBe("1 20/20");
	});

	it("scores a project the scrape left no records for over its own row alone", async () => {
		const { db, updates, created } = stubDb(fixture());
		await scoreOneProject(db, "E", points);

		expect(byTable(created[0])).toEqual({ ProjectTable: "1 1/1" });
		expect(updates[0].data).toMatchObject({ scorePointsAvailable: 1, scorePointsScored: 1 });
	});

	it("gives an unchanged project the same numbers on a rescore: its own score columns are never fields", async () => {
		const tables = fixture();
		const { db, updates, created } = stubDb(tables);
		await scoreOneProject(db, "A", points);
		// The first run's numbers are on the row when the second reads it.
		expect(tables.projectTable[0]).toMatchObject({ scorePointsScored: 42, scorePointsAvailable: 63, scoreProjectFlag: false });
		await scoreOneProject(db, "A", points);

		const numbers = ({ scorePointsScored, scorePointsAvailable, scoreProject }: Record<string, unknown>) =>
			({ scorePointsScored, scorePointsAvailable, scoreProject });
		expect(numbers(updates[1].data)).toEqual(numbers(updates[0].data));
		expect(created[1].map((r) => r.fieldName)).toEqual(created[0].map((r) => r.fieldName));
		expect(created[1].some((r) => /^ProjectTable\.(score|is)/.test(r.fieldName))).toBe(false);
	});

	// An org's Tier 4 is the mean of its projects' scores, so a project scored
	// for any reason — a land-only change included — leaves its orgs stale.
	it("flags every live org standing on the project, before clearing the project's own flag", async () => {
		const { db, orgMarks, order } = stubDb(fixture());
		await scoreOneProject(db, "A", points);

		expect(orgMarks).toEqual([
			{
				where: {
					deletedAt: null,
					OR: [{ scoreOrgFlag: false }, { scoreOrgFlag: null }],
					stakeholderTables: { some: { projectKey: "A", deletedAt: null } },
				},
				data: { scoreOrgFlag: true },
			},
		]);
		// Marked first: a failure between the two then leaves the project dirty to retry, never an org stale.
		expect(order).toEqual(["orgs", "project"]);
	});

	it("writes nothing for a key that does not exist", async () => {
		const { db, updates, deleted, orgMarks } = stubDb(fixture());
		await scoreOneProject(db, "nope", points);
		expect(updates).toEqual([]);
		expect(deleted).toEqual([]);
		expect(orgMarks).toEqual([]);
	});
});
