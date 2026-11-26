import { describe, expect, it } from "vitest";
import { BONUSABLE, bonusableScores, earned, fieldPoints, fieldScores, isRealPolygon, OFFERED, populated, scoreOneProject, WORD_CAPS } from "./projectScore";
import config from "./scoreConfig.json" with { type: "json" };
import { SCORE_MATRIX } from "./scoreMatrix";

const points = fieldPoints(new Map([["geometry", 20]]), 1);
const SQUARE = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };

describe("fieldPoints", () => {
	it("weights from the matrix, the default for any other field, 0 for a system field", () => {
		expect(points("geometry")).toBe(20);
		expect(points("hectares")).toBe(1);
		expect(points("isQualityPass")).toBe(1);
		for (const f of ["projectKey", "createdAt", "editedBy", "platformId", "parentTable", "parentKey", "randomJson", "provenance"])
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

describe("populated: a value by its type", () => {
	it.each([
		["landName", "Plot 4", true],
		["landName", "unknown", false],
		["landName", "--", false],
		["landDesc", "...", false],
		["motivationSource", "[]", false],
		["cropDesc", "-\r\n", false],
		["landDesc", "0", true],
		["landDesc", "csm", true],
		["hectaresCalc", 0, true],
		["plantedQty", 0, true],
		["plantedQty", Number.NaN, false],
		["latitude", -3.2, true],
		["radius", -1, false],
		["hectares", { toNumber: () => 2.5 }, true],
		["hectares", { toNumber: () => 0 }, false],
		["plantingDt", new Date("x"), false],
		["plantingDt", new Date("2026-01-01"), true],
		["isQualityPass", false, true],
		["plotCenter", {}, false],
		["plotCenter", { lat: 1, lon: 2 }, true],
		["speciesIds", [], false],
		["landDesc", "<p><br></p>", false],
		["landDesc", "<p>&nbsp;</p>", false],
		["landDesc", "<p>n/a</p>", false],
		["landDesc", "<div><span></span></div>", false],
		["landDesc", "<p>Plot 4</p>", true],
		["landDesc", "a < b", true],
	])("%s = %j → %s", (field, value, expected) => {
		expect(populated(field, value)).toBe(expected);
	});

	it("a polygon is real only with an enclosing outer ring, wherever it is wrapped", () => {
		const multi = { type: "MultiPolygon", coordinates: [[[[5, 5], [5, 5], [5, 5]]], SQUARE.coordinates] };
		expect(isRealPolygon(SQUARE)).toBe(true);
		expect(isRealPolygon(JSON.stringify(SQUARE))).toBe(true);
		expect(isRealPolygon(multi)).toBe(true);
		expect(isRealPolygon({ type: "FeatureCollection", features: [{ type: "Feature", geometry: multi }] })).toBe(true);
		expect(isRealPolygon({ type: "GeometryCollection", geometries: [SQUARE] })).toBe(true);
		expect(isRealPolygon("{}")).toBe(false);
		expect(isRealPolygon("not json")).toBe(false);
		expect(isRealPolygon({ type: "Polygon", coordinates: [] })).toBe(false);
		expect(isRealPolygon({ type: "Polygon", coordinates: [[[0, 0], [1, 1]]] })).toBe(false);
		expect(isRealPolygon({ type: "LineString", coordinates: [[0, 0], [1, 1], [1, 0]] })).toBe(false);
	});
});

describe("fieldScores", () => {
	it("one row per offered field per record, named Table.field; a column the list does not name is never a field", () => {
		const rows = fieldScores(
			"p",
			{
				LandTable: [
					{ landKey: "l1", hectares: 3, geometry: null, landName: "" },
					{ landKey: "l2", hectares: null, geometry: SQUARE, landName: "x" },
				],
			},
			points,
		);
		expect(rows.map((r) => `${r.fieldName}=${r.pointsAwarded}/${r.pointsAvailable}`)).toEqual([
			"LandTable.landName=0/1",
			"LandTable.hectares=1/1",
			"LandTable.latitude=0/1",
			"LandTable.longitude=0/1",
			"LandTable.landDesc=0/1",
			"LandTable.preparation=0/1",
			"LandTable.landName=1/1",
			"LandTable.hectares=0/1",
			"LandTable.latitude=0/1",
			"LandTable.longitude=0/1",
			"LandTable.landDesc=0/1",
			"LandTable.preparation=0/1",
		]);
		expect(rows.every((r) => r.projectKey === "p")).toBe(true);
		expect(new Set(rows.map((r) => r.granularProjectScoreId)).size).toBe(12);
		expect(rows.map((r) => `${r.recordTable}:${r.recordKey}`)).toEqual([...Array(6).fill("LandTable:l1"), ...Array(6).fill("LandTable:l2")]);
	});

	it("a table with no record offers one record's worth, unscored, under no key", () => {
		const tally = (table: string) => {
			const rows = fieldScores("p", { [table]: [] }, weighted);
			expect(rows.every((r) => r.recordTable === table && r.recordKey === null && !r.isAwarded), table).toBe(true);
			return `${rows.reduce((s, r) => s + r.pointsAwarded, 0)}/${rows.reduce((s, r) => s + r.pointsAvailable, 0)}`;
		};
		expect(tally("PlantingTable")).toBe("0/160");
		expect(tally("LandTable")).toBe("0/140");
		expect(tally("PolygonTable")).toBe("0/250");
		expect(tally("OrganizationTable")).toBe("0/90");
		expect(tally("ClaimTable")).toBe("0/40");
	});

	it("a placeholder earns nothing: {} geometry, a point, a zero-area ring, blank or 'N/A' text, Null Island, a 0 size", () => {
		const rows = fieldScores(
			"p",
			{
				PolygonTable: [
					{ polygonKey: "g1", geometry: {} },
					{ polygonKey: "g2", geometry: { type: "Point", coordinates: [1, 2] } },
					{ polygonKey: "g3", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] } },
					{ polygonKey: "g4", geometry: { type: "Feature", geometry: SQUARE } },
				],
				LandTable: [{ landKey: "l1", landName: " N/A ", landDesc: "  ", latitude: 0, longitude: 0.5, hectares: 0 }],
			},
			points,
		);
		const set = rows.filter((r) => (r.recordTable === "PolygonTable" ? r.fieldName.endsWith(".geometry") : !r.fieldName.endsWith(".preparation")));
		expect(set.map((r) => `${r.recordKey}.${r.fieldName.split(".")[1]}=${r.pointsAwarded}`)).toEqual([
			"g1.geometry=0",
			"g2.geometry=0",
			"g3.geometry=0",
			"g4.geometry=20",
			"l1.landName=0",
			"l1.hectares=0",
			"l1.latitude=0",
			"l1.longitude=1",
			"l1.landDesc=0",
		]);
	});

	it("refuses a record it cannot name: a point must lead to its row", () => {
		expect(() => fieldScores("p", { LandTable: [{ hectares: 3 }] }, points)).toThrow(/LandTable: a scored record without its landKey/);
		expect(() => fieldScores("p", { PlatformTable: [{ platformId: "a" }] }, points)).toThrow(/PlatformTable: not a scored table/);
	});
});

describe("a field earns for how much it says", () => {
	const tenths = fieldPoints(new Map(), 10);
	const say = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
	const desc = (projectDesc: unknown) =>
		fieldScores("p", { ProjectTable: [{ projectKey: "p", projectName: "Mangroves", projectDesc }] }, tenths)
			.filter((r) => r.fieldName === "ProjectTable.projectDesc")
			.map((r) => `${r.pointsAwarded}/${r.pointsAvailable}`)[0];

	it("a description below its cap earns its share in words, rounded up, so one word earns something", () => {
		const cap = WORD_CAPS["ProjectTable.projectDesc"];
		expect(desc(say(1))).toBe("1/10");
		expect(desc(say(cap / 10))).toBe("1/10");
		expect(desc(say(cap / 10 + 1))).toBe("2/10");
		expect(desc(say(cap / 2))).toBe("5/10");
		expect(desc(say(cap - 1))).toBe("10/10");
	});

	it("one at its cap earns all of it, and one twice the cap earns no more", () => {
		const cap = WORD_CAPS["ProjectTable.projectDesc"];
		expect(desc(say(cap))).toBe("10/10");
		expect(desc(say(cap * 2))).toBe("10/10");
	});

	it("markup earns nothing and is never a word; punctuation alone is not a word", () => {
		expect(desc("<p><br></p>")).toBe("0/10");
		expect(desc("<p>&nbsp;</p>")).toBe("0/10");
		expect(earned("ProjectTable", "projectDesc", `<p>${say(31)}</p><p>&nbsp;</p>`, 10)).toBe(1);
		expect(earned("ProjectTable", "projectDesc", `${say(31)} — … - ${say(1)}`, 10)).toBe(2);
		expect(desc(null)).toBe("0/10");
	});

	it("a field without a cap is whole or nothing, however short", () => {
		expect(earned("ProjectTable", "projectName", "M", 10)).toBe(10);
		expect(earned("MiscTable", "motivationSource", '["OTHER"]', 10)).toBe(10);
		expect(earned("LandTable", "hectares", 3, 10)).toBe(10);
		expect(earned("LandTable", "hectares", 0, 10)).toBe(0);
	});

	it("a by-field row is awarded when it earns anything, and never more than it offers", () => {
		const rows = fieldScores("p", { LandTable: [{ landKey: "l1", landName: "Plot", landDesc: say(3) }] }, tenths);
		const land = rows.find((r) => r.fieldName === "LandTable.landDesc");
		expect(land).toMatchObject({ isAwarded: true, pointsAwarded: 1, pointsAvailable: 10 });
		for (const r of rows) expect(r.pointsAwarded).toBeLessThanOrEqual(r.pointsAvailable);
	});

	it("every cap names an offered field or a bonusable baseline field", () => {
		const scored = new Set([
			...Object.entries(OFFERED).flatMap(([t, fields]) => fields.map((f) => `${t}.${f}`)),
			...Object.entries(BONUSABLE).flatMap(([t, rule]) => rule.baseline.map((f) => `${t}.${f}`)),
		]);
		for (const [field, cap] of Object.entries(WORD_CAPS)) {
			expect(scored.has(field), field).toBe(true);
			expect(Number.isInteger(cap) && cap > 0, field).toBe(true);
		}
	});
});

type Row = Record<string, unknown>;
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
	const created: { fieldName: string; pointsAwarded: number; pointsAvailable: number; scoreRunId: string }[][] = [];
	const orgMarks: { where: Where; data: Record<string, unknown> }[] = [];
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
			...delegate("organizationTable"),
			updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
				orgMarks.push(args);
				return { count: 0 };
			},
		},
		claimTable: delegate("claimTable"),
		surveyTable: delegate("surveyTable"),
		sourceTable: delegate("sourceTable"),
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
		// Which claims are current is orgScore's SQL to prove; here it is the rows marked so.
		$queryRaw: async () => (tables.claimTable ?? []).filter((c) => c.current).map(({ claimKey, claimQty }) => ({ claimKey, claimQty })),
		// Rollback is Postgres's to prove: scoreWrites.test.ts.
		$transaction: (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db),
	};
	return { db: db as never, updates, deleted, created, asked, included, orgMarks };
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

// Five projects, each 1:1 with a platform's record: A and B are the same
// project as two platforms published it, L is a third, E was scraped with no
// records at all, O has partners. Under A a soft-deleted land, under l1 a
// soft-deleted polygon: records that no longer exist.
const fixture = (): Record<string, Row[]> => ({
	projectTable: [
		{ projectKey: "A", projectName: "Mangrove (a)", ...unscored },
		{ projectKey: "B", projectName: "Mangrove (b)", ...unscored },
		{ projectKey: "L", projectName: "Lone", ...unscored },
		{ projectKey: "E", projectName: "Empty", ...unscored },
		{ projectKey: "O", projectName: "Partnered", ...unscored },
	],
	landTable: [
		{
			landKey: "l1",
			projectKey: "A",
			hectares: 3,
			geometry: SQUARE,
			PolygonTable: [
				{ polygonKey: "g1", landKey: "l1", geometry: SQUARE },
				{ polygonKey: "g2", landKey: "l1", geometry: SQUARE, deletedAt: gone },
			],
		},
		{ landKey: "l2", projectKey: "A", hectares: null, geometry: null, PolygonTable: [] },
		{ landKey: "l3", projectKey: "B", hectares: 1, geometry: null, PolygonTable: [] },
		{ landKey: "l4", projectKey: "L", hectares: 2, geometry: null, PolygonTable: [] },
		{ landKey: "l5", projectKey: "A", hectares: 9, geometry: SQUARE, deletedAt: gone, PolygonTable: [] },
	],
	cropTable: [{ cropKey: "c1", projectKey: "B", cropName: "Rhizophora", SpeciesTable: [] }],
	stakeholderTable: [
		{ stakeholderKey: "s1", projectKey: "O", organizationKey: "org1", stakeholderCategory: "developer" },
		{ stakeholderKey: "s2", projectKey: "O", organizationKey: "org1", stakeholderCategory: "funder" },
		{ stakeholderKey: "s3", projectKey: "O", organizationKey: "org2", stakeholderCategory: "funder" },
	],
	organizationTable: [
		{ organizationKey: "org1", organizationName: "Org", website: "https://o", latitude: 1.5, primaryStakeholderCategory: "developer" },
		{ organizationKey: "org2", organizationName: "Gone", deletedAt: gone },
	],
	claimTable: [
		{ claimKey: "k1", organizationKey: "org1", claimQty: 10, claimCategory: "trees", current: true },
		{ claimKey: "k2", organizationKey: "org1", claimQty: 20, claimDt: gone },
	],
});

// What a table with no record offers under `points`: one record's worth.
const EMPTY = {
	LandTable: "6 0/6",
	PolygonTable: "6 0/25",
	CropTable: "6 0/6",
	SpeciesTable: "5 0/5",
	PlantingTable: "8 0/8",
	MiscTable: "14 0/14",
	StakeholderTable: "1 0/1",
	OrganizationTable: "9 0/9",
	ClaimTable: "4 0/4",
	SurveyTable: "4 0/4",
	SourceTable: "6 0/6", // no source: the baseline is available and scores nothing
};

const CHILD_TABLES = ["landTable", "cropTable", "plantingTable", "miscTable", "stakeholderTable", "surveyTable", "sourceTable"];

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
		await scoreOneProject(db, "A", points, "run-1");

		// records: fields scored/available
		expect(byTable(created[0])).toEqual({
			...EMPTY,
			ProjectTable: "5 1/5", // projectName — keys, stamps, the score columns and both flags are never offered
			LandTable: "12 1/12", // l1's hectares; a land's geometry and its PolygonTable array are not fields
			PolygonTable: "6 20/25",
		});
		expect(asked.landTable).toEqual([{ projectKey: { in: ["A"] }, deletedAt: null }]);
		expect(deleted).toEqual([{ projectKey: "A" }]);
		expect(created[0].every((r) => r.scoreRunId === "run-1")).toBe(true);
		expect(updates).toEqual([
			{
				where: { projectKey: "A" },
				data: {
					scoreProject: 22 / 99,
					scorePointsAvailable: 99,
					scorePointsScored: 22,
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
		await scoreOneProject(db, "B", points, "run-1");

		expect(byTable(created[0])).toEqual({
			...EMPTY,
			ProjectTable: "5 1/5",
			LandTable: "6 1/6",
			CropTable: "6 1/6", // an unlinked crop misses its species
		});
		expect(asked.landTable).toEqual([{ projectKey: { in: ["B"] }, deletedAt: null }]);
		expect(updates[0].data).toMatchObject({ scorePointsAvailable: 93, scorePointsScored: 3 });
	});

	// A walk over ProjectTable is what a hierarchy needed; there is none, so the
	// scorer reads the one row by key and never lists the table.
	it("never reads a second project row", async () => {
		const { db, asked } = stubDb(fixture());
		await scoreOneProject(db, "A", points, "run-1");
		expect(asked.projectTable).toBeUndefined();
	});

	it("counts no soft-deleted record: every child query is live-only, and so is a land's polygons", async () => {
		const { db, created, asked, included } = stubDb(fixture());
		await scoreOneProject(db, "A", points, "run-1");

		for (const t of CHILD_TABLES)
			expect(asked[t], t).toEqual([{ projectKey: { in: ["A"] }, deletedAt: null }]);
		expect(included.landTable).toEqual([{ PolygonTable: { where: { deletedAt: null } } }]);
		// l5 (9 ha) would have been a third land record and g2 a second polygon
		expect(byTable(created[0]).LandTable).toBe("12 1/12");
		expect(byTable(created[0]).PolygonTable).toBe("6 20/25");
	});

	it("a project the scrape left no records for is still offered one record of every table", async () => {
		const { db, updates, created } = stubDb(fixture());
		await scoreOneProject(db, "E", points, "run-1");

		expect(byTable(created[0])).toEqual({ ...EMPTY, ProjectTable: "5 1/5" });
		expect(created[0].filter((r) => !r.fieldName.startsWith("ProjectTable.")).every((r) => (r as { recordKey?: unknown }).recordKey === null)).toBe(true);
		expect(updates[0].data).toMatchObject({ scorePointsAvailable: 93, scorePointsScored: 1 });
	});

	it("scores an organization once however many stakeholders name it, and only its current claims", async () => {
		const { db, created, asked } = stubDb(fixture());
		await scoreOneProject(db, "O", points, "run-1");

		expect(byTable(created[0])).toMatchObject({
			StakeholderTable: "3 3/3",
			// org1's name and website; its coordinate and its category are ReTreever's, never fields. org2 is deleted.
			OrganizationTable: "9 2/9",
			// k1's quantity; k2 is not current.
			ClaimTable: "4 1/4",
		});
		expect(asked.organizationTable).toEqual([{ organizationKey: { in: ["org1", "org2"] }, deletedAt: null }]);
		expect(asked.claimTable).toEqual([{ claimKey: { in: ["k1"] } }]);
	});

	it("gives an unchanged project the same numbers on a rescore: its own score columns are never fields", async () => {
		const tables = fixture();
		const { db, updates, created } = stubDb(tables);
		await scoreOneProject(db, "A", points, "run-1");
		// The first run's numbers are on the row when the second reads it.
		expect(tables.projectTable[0]).toMatchObject({ scorePointsScored: 22, scorePointsAvailable: 99, scoreProjectFlag: false });
		await scoreOneProject(db, "A", points, "run-1");

		const numbers = ({ scorePointsScored, scorePointsAvailable, scoreProject }: Record<string, unknown>) =>
			({ scorePointsScored, scorePointsAvailable, scoreProject });
		expect(numbers(updates[1].data)).toEqual(numbers(updates[0].data));
		expect(created[1].map((r) => r.fieldName)).toEqual(created[0].map((r) => r.fieldName));
		expect(created[1].some((r) => /^ProjectTable\.(score|is)/.test(r.fieldName))).toBe(false);
	});

	// An org's Tier 4 is the mean of its projects' scores, so a project scored
	// for any reason — a land-only change included — leaves its orgs stale.
	it("flags every live org standing on the project", async () => {
		const { db, orgMarks } = stubDb(fixture());
		await scoreOneProject(db, "A", points, "run-1");

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
	});

	it("writes nothing for a key that does not exist", async () => {
		const { db, updates, deleted, orgMarks } = stubDb(fixture());
		await scoreOneProject(db, "nope", points, "run-1");
		expect(updates).toEqual([]);
		expect(deleted).toEqual([]);
		expect(orgMarks).toEqual([]);
	});
});

// The bootstrap weights, so these numbers are the ones theScore.md's example shows.
const weighted = fieldPoints(
	new Map(Object.entries(SCORE_MATRIX).map(([f, { points }]) => [f, points])),
	config.defaults.fieldPoints,
);
const BASELINE = ["url", "urlType", "disclosureType", "sourceDesc", "sourceCredit", "stakeholderCategoryId"];

let n = 0;
/** A live source on project S; every column a scraped row carries, only `filled` set. */
const source = (filled: Record<string, unknown>, extra: Record<string, unknown> = {}): Row => ({
	sourceKey: `s${String(++n).padStart(4, "0")}`,
	projectKey: "S",
	url: null,
	urlType: null,
	disclosureType: null,
	sourceDesc: null,
	sourceCredit: null,
	stakeholderCategoryId: null,
	parentKey: "S",
	parentTable: "projectTable",
	organizationKey: null,
	displayRank: 5,
	deletedAt: null,
	stakeholderCategorySource: null,
	captureStatus: "pending",
	captureFinalUrl: null,
	captureHttpStatus: null,
	captureStorageKey: null,
	captureProvenance: null,
	captureError: null,
	captureAttempts: 0,
	isValidated: false,
	...filled,
	...extra,
});
const photo = (desc?: string) =>
	source({ url: "https://x/p.jpg", urlType: "image", ...(desc ? { sourceDesc: desc } : {}) });

async function scoreSources(sources: Row[]) {
	const { db, updates, created } = stubDb({
		projectTable: [{ projectKey: "S", projectName: "Sourced", ...unscored }],
		sourceTable: sources,
	});
	await scoreOneProject(db, "S", weighted, "run-1");
	const rows = created[0].filter((r) => r.fieldName.startsWith("SourceTable."));
	return {
		data: updates[0].data,
		source: byTable(rows).SourceTable,
		fields: rows.map((r) => `${r.fieldName.slice("SourceTable.".length)}=${r.pointsAwarded}/${r.pointsAvailable}`),
	};
}

describe("sources: the first is a baseline, further ones a capped bonus", () => {
	it("no source: the six baseline fields are available and score nothing, so the project row alone cannot reach 100%", async () => {
		const { data, source: src, fields } = await scoreSources([]);
		expect(fields).toEqual([
			"url=0/10",
			"urlType=0/10",
			"disclosureType=0/10",
			"sourceDesc=0/10",
			"sourceCredit=0/10",
			"stakeholderCategoryId=0/10",
		]);
		expect(src).toBe("6 0/60");
		// The project's name, of its own 50, the baseline's 60 and the 1,150 every other table offers.
		expect(data).toMatchObject({ scorePointsScored: 10, scorePointsAvailable: 1260 });
		expect(data.scoreProject).toBeLessThan(1);
	});

	it("one source with half its baseline filled: every baseline field counts, filled or not", async () => {
		const { source: src, fields } = await scoreSources([
			source({ url: "https://x", urlType: "webpage", sourceDesc: "Project page" }),
		]);
		// "Project page" is 2 words of the caption's 30: a tenth, rounded up.
		expect(fields).toEqual([
			"url=10/10",
			"urlType=10/10",
			"disclosureType=0/10",
			"sourceDesc=1/10",
			"sourceCredit=0/10",
			"stakeholderCategoryId=0/10",
		]);
		expect(src).toBe("6 21/60");
	});

	// theScore.md § Bonusable tables, worked example.
	it("three sources: the best-filled is the baseline, the others add only what they fill", async () => {
		const page = source({ url: "https://x", urlType: "webpage", sourceDesc: "Project page", sourceCredit: "A. Ranger" });
		const credited = source({ url: "https://x/a.jpg", urlType: "image", sourceCredit: "J. Doe" });
		const report = source({ url: "https://x/r.pdf", urlType: "document", sourceDesc: "Annual report" });
		const { data, source: src, fields } = await scoreSources([report, credited, page]);
		expect(fields).toEqual([
			// page: 31 of 60, its two-word caption a tenth of 10
			"url=10/10",
			"urlType=10/10",
			"disclosureType=0/10",
			"sourceDesc=1/10",
			"sourceCredit=10/10",
			"stakeholderCategoryId=0/10",
			// credited: +30 of +30
			"url=10/10",
			"urlType=10/10",
			"sourceCredit=10/10",
			// report: +21 of +21, its caption offered only what it earns
			"url=10/10",
			"urlType=10/10",
			"sourceDesc=1/1",
		]);
		expect(src).toBe("12 82/111");
		expect(data).toMatchObject({ scorePointsScored: 92, scorePointsAvailable: 1311 });
	});

	it("120 sources of one urlType score what one does", async () => {
		const one = await scoreSources([photo("Nursery")]);
		const many = await scoreSources(Array.from({ length: 120 }, () => photo("Nursery")));
		expect(one.source).toBe("6 21/60");
		expect(many.fields).toEqual(one.fields);
		expect(many.data).toEqual({ ...one.data, scoreLastUpdatedAt: expect.any(Date) });
	});

	it("a capped urlType counts its best-filled source, whatever order the rows come in", async () => {
		const bare = photo();
		const described = photo("Seedlings at week 6");
		const page = source({ url: "https://x", urlType: "webpage" });
		const a = await scoreSources([bare, described, page]);
		const b = await scoreSources([page, described, bare]);
		expect(a.fields).toEqual(b.fields);
		// the baseline is the described photo (22 points earned) over the page and the bare photo (20 each)
		expect(a.source).toBe("8 42/80");
	});

	it("of two photos, the one whose caption says more is the baseline and earns more", async () => {
		const caption = Array.from({ length: WORD_CAPS["SourceTable.sourceDesc"] }, (_, i) => `w${i}`).join(" ");
		const { fields } = await scoreSources([photo("Photo"), photo(caption)]);
		expect(fields.filter((f) => f.startsWith("sourceDesc="))).toEqual(["sourceDesc=10/10"]);
		const short = await scoreSources([photo("Photo")]);
		expect(short.fields.filter((f) => f.startsWith("sourceDesc="))).toEqual(["sourceDesc=1/10"]);
	});

	it("a soft-deleted source counts as none", async () => {
		const none = await scoreSources([]);
		const deleted = await scoreSources([
			source({ url: "https://x", urlType: "webpage", sourceDesc: "d", sourceCredit: "c" }, { deletedAt: gone }),
		]);
		expect(deleted.source).toBe("6 0/60");
		expect(deleted.fields).toEqual(none.fields);
		expect(deleted.data).toEqual({ ...none.data, scoreLastUpdatedAt: expect.any(Date) });
	});

	it("only the six baseline fields ever count: a source's other columns are never a field", async () => {
		const plain = await scoreSources([source({ url: "https://x", urlType: "webpage" })]);
		const busy = await scoreSources([
			source(
				{ url: "https://x", urlType: "webpage" },
				{
					parentKey: "l1",
					parentTable: "landTable",
					organizationKey: "o1",
					displayRank: 1,
					stakeholderCategorySource: "NGO",
					captureStatus: "captured",
					captureFinalUrl: "https://y",
					captureHttpStatus: 200,
					captureStorageKey: "k",
					captureManifestSha: "abc",
					captureProvenance: { tls: 1 },
					captureError: "none",
					captureAttempts: 3,
					isValidated: true,
					validatedBy: "admin",
				},
			),
		]);
		expect(busy.fields).toEqual(plain.fields);
		expect(busy.data).toEqual({ ...plain.data, scoreLastUpdatedAt: expect.any(Date) });
		expect(busy.fields.map((f) => f.split("=")[0])).toEqual(BASELINE);
	});
});

describe("bonusableScores", () => {
	it("SourceTable is the only table on the rule; another joins by listing its baseline fields", () => {
		expect(Object.keys(BONUSABLE)).toEqual(["SourceTable"]);
		const crops = [
			{ cropKey: "c2", cropName: "Rhizophora", speciesName: null, cropDesc: "x" },
			{ cropKey: "c1", cropName: null, speciesName: null, cropDesc: null },
		];
		const rows = bonusableScores("p", "CropTable", crops, { baseline: ["cropName", "speciesName"] }, weighted);
		expect(rows.map((r) => `${r.fieldName}=${r.pointsAwarded}/${r.pointsAvailable}`)).toEqual([
			"CropTable.cropName=50/50",
			"CropTable.speciesName=0/50",
		]);
	});
});
