import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { scoreOneOrg } from "./orgScore";
import { fieldPoints, RECORD_KEY, scoreOneProject } from "./projectScore";

// The scorers' writes against Postgres with ReTreever's real schema: what a
// trace reads back is what these leave behind.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const points = fieldPoints(new Map([["geometry", 20]]), 1);

async function seedProject(projectKey: string, records = true) {
	const db = t.prisma;
	await db.projectTable.create({ data: { projectKey, projectName: `Project ${projectKey}`, scoreProjectFlag: true } });
	if (!records) return;
	await db.organizationTable.create({ data: { organizationKey: `o-${projectKey}`, organizationName: "Org" } });
	await db.landTable.create({ data: { landKey: `${projectKey}-l1`, landName: "Plot", projectKey, hectares: 3 } });
	await db.landTable.create({ data: { landKey: `${projectKey}-l2`, landName: "Gone", projectKey, deletedAt: new Date() } });
	await db.polygonTable.create({ data: { polygonKey: `${projectKey}-g1`, landKey: `${projectKey}-l1`, geometry: {} } });
	await db.plantingTable.create({ data: { plantingKey: `${projectKey}-t1`, projectKey, parentKey: `${projectKey}-l1`, parentTable: "landTable", plantedQty: 40 } });
	await db.cropTable.create({ data: { cropKey: `${projectKey}-c1`, cropName: "Rhizophora", projectKey } });
	await db.miscTable.create({ data: { polyKey: `${projectKey}-m1`, projectKey, parentKey: projectKey, parentTable: "projectTable" } });
	await db.surveyTable.create({ data: { plotKey: `${projectKey}-v1`, projectKey } });
	await db.stakeholderTable.create({
		data: { stakeholderKey: `${projectKey}-s1`, organizationKey: `o-${projectKey}`, projectKey, parentKey: projectKey, parentTable: "projectTable" },
	});
	for (const [k, urlType] of [["a", "webpage"], ["b", "image"]] as const)
		await db.sourceTable.create({
			data: { sourceKey: `${projectKey}-src-${k}`, projectKey, url: `https://x/${k}`, urlType, sourceDesc: k === "a" ? "Page" : null },
		});
}

const rowsOf = (projectKey: string) =>
	t.prisma.projectScoreByFieldTable.findMany({
		where: { projectKey },
		select: { fieldName: true, recordTable: true, recordKey: true, isAwarded: true },
		orderBy: [{ fieldName: "asc" }, { recordKey: "asc" }],
	});

describe("scoreOneProject: each point names its record", () => {
	it("every by-field row carries its record's table and primary key, live records only", async () => {
		await seedProject("a-1");
		await scoreOneProject(t.prisma, "a-1", points);
		const rows = await rowsOf("a-1");

		for (const r of rows) expect(r.fieldName.split(".")[0], r.fieldName).toBe(r.recordTable);
		const records = [...new Set(rows.map((r) => `${r.recordTable}:${r.recordKey}`))].sort();
		expect(records).toEqual([
			"CropTable:a-1-c1",
			"LandTable:a-1-l1",
			"MiscTable:a-1-m1",
			"PlantingTable:a-1-t1",
			"PolygonTable:a-1-g1",
			"ProjectTable:a-1",
			"SourceTable:a-1-src-a",
			"SourceTable:a-1-src-b",
			"StakeholderTable:a-1-s1",
			"SurveyTable:a-1-v1",
		]);
	});

	it("names the baseline source by its best-filled record, and a bonus row by its own", async () => {
		await seedProject("a-1");
		await scoreOneProject(t.prisma, "a-1", points);
		const sources = (await rowsOf("a-1")).filter((r) => r.recordTable === "SourceTable");
		// a (url, urlType, sourceDesc) is the baseline: all six fields; b adds only what it fills.
		expect(sources.filter((r) => r.recordKey === "a-1-src-a")).toHaveLength(6);
		expect(sources.filter((r) => r.recordKey === "a-1-src-b").map((r) => r.fieldName)).toEqual([
			"SourceTable.url",
			"SourceTable.urlType",
		]);
	});

	it("a project with no source: the six baseline rows name the table and no record", async () => {
		await seedProject("e-1", false);
		await scoreOneProject(t.prisma, "e-1", points);
		const rows = await rowsOf("e-1");
		expect(rows.filter((r) => r.recordKey === null)).toEqual(
			["disclosureType", "sourceCredit", "sourceDesc", "stakeholderCategoryId", "url", "urlType"].map((f) => ({
				fieldName: `SourceTable.${f}`,
				recordTable: "SourceTable",
				recordKey: null,
				isAwarded: false,
			})),
		);
		expect(rows.filter((r) => r.recordKey !== null).every((r) => r.recordTable === "ProjectTable" && r.recordKey === "e-1")).toBe(true);
	});

	it("a rescore replaces the project's rows rather than adding to them", async () => {
		await seedProject("a-1");
		await scoreOneProject(t.prisma, "a-1", points);
		const first = await rowsOf("a-1");
		await scoreOneProject(t.prisma, "a-1", points);
		expect(await rowsOf("a-1")).toEqual(first);
	});

	it("RECORD_KEY names each scored table's primary key as Postgres has it", async () => {
		const pks = await t.prisma.$queryRaw<{ table: string; column: string }[]>`
			SELECT tc.table_name AS "table", kcu.column_name AS "column"
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
			WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = ANY(${Object.keys(RECORD_KEY)}::text[])`;
		expect(Object.fromEntries(pks.map((p) => [p.table, p.column]))).toEqual(RECORD_KEY);
	});
});

async function seedOrgs() {
	const db = t.prisma;
	await db.organizationTable.create({ data: { organizationKey: "p-eden", organizationName: "Eden", scoreOrgFlag: true } });
	for (const k of ["a-eden", "c-eden"])
		await db.organizationTable.create({ data: { organizationKey: k, organizationName: k, organizationParentKey: "p-eden", scoreOrgFlag: true } });
	const project = (projectKey: string, scoreProject: number | null, scorePointsScored: number | null, scorePointsAvailable: number | null) =>
		db.projectTable.create({ data: { projectKey, projectName: projectKey, scoreProject, scorePointsScored, scorePointsAvailable } });
	await project("a-1", 0.5, 5, 10);
	await project("c-2", 0.75, 3, 4);
	await project("c-3", null, null, null);
	const link = (stakeholderKey: string, organizationKey: string, projectKey: string) =>
		db.stakeholderTable.create({ data: { stakeholderKey, organizationKey, projectKey, parentKey: projectKey, parentTable: "projectTable", stakeholderCategory: "developer_ish" } });
	await link("s1", "a-eden", "a-1");
	await link("s2", "c-eden", "c-2");
	await link("s3", "c-eden", "c-3");
	await link("s4", "a-eden", "c-2");
	await db.plantingTable.create({ data: { plantingKey: "t1", projectKey: "c-2", parentKey: "c-2", parentTable: "projectTable", plantedQty: 40 } });
	await db.plantingTable.create({ data: { plantingKey: "t2", projectKey: "c-3", parentKey: "c-3", parentTable: "projectTable", plantedQty: 2 } });
}

const inputsOf = (organizationKey: string) =>
	t.prisma.orgScoreInputTable.findMany({ where: { organizationKey }, orderBy: { projectKey: "asc" } });

describe("scoreOneOrg: each org keeps what it averaged", () => {
	it("writes one input per linked project, as averaged, stamped with the org's own scoring time", async () => {
		await seedOrgs();
		await scoreOneOrg(t.prisma, "p-eden");
		const org = await t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey: "p-eden" } });
		const inputs = await inputsOf("p-eden");

		expect(inputs.map((i) => ({ ...i, scoreProject: i.scoreProject === null ? null : Number(i.scoreProject) }))).toEqual([
			{ organizationKey: "p-eden", projectKey: "a-1", viaOrganizationKeys: ["a-eden"], scoreProject: 0.5, scorePointsScored: 5, scorePointsAvailable: 10, plantedQty: 0, scoredAt: org.scoreLastUpdatedAt },
			{ organizationKey: "p-eden", projectKey: "c-2", viaOrganizationKeys: ["a-eden", "c-eden"], scoreProject: 0.75, scorePointsScored: 3, scorePointsAvailable: 4, plantedQty: 40, scoredAt: org.scoreLastUpdatedAt },
			{ organizationKey: "p-eden", projectKey: "c-3", viaOrganizationKeys: ["c-eden"], scoreProject: null, scorePointsScored: null, scorePointsAvailable: null, plantedQty: 2, scoredAt: org.scoreLastUpdatedAt },
		]);
		// The stored numbers are the inputs' own: the mean of the scored, the planted sum of all.
		expect(Number(org.scoreOrgPreClaim)).toBeCloseTo(0.625, 12);
		expect(org.scoreSumPlantedQty).toBe(42);
		expect(org.scorePointsScored).toBe(8);
	});

	it("a rescore replaces the inputs whole: a project unlinked since is gone, not kept", async () => {
		await seedOrgs();
		await scoreOneOrg(t.prisma, "p-eden");
		await t.prisma.stakeholderTable.updateMany({ where: { projectKey: "c-3" }, data: { deletedAt: new Date() } });
		await scoreOneOrg(t.prisma, "p-eden");
		expect((await inputsOf("p-eden")).map((i) => i.projectKey)).toEqual(["a-1", "c-2"]);
	});

	it("a child writes no inputs, and drops any it held as a top-level org", async () => {
		await seedOrgs();
		await t.prisma.orgScoreInputTable.create({
			data: { organizationKey: "a-eden", projectKey: "a-1", viaOrganizationKeys: ["a-eden"], scoredAt: new Date("2026-10-01") },
		});
		await scoreOneOrg(t.prisma, "a-eden");
		expect(await inputsOf("a-eden")).toEqual([]);
	});

	it("an org with no linked project writes none and scores 0", async () => {
		await t.prisma.organizationTable.create({ data: { organizationKey: "a-lone", organizationName: "Lone" } });
		await scoreOneOrg(t.prisma, "a-lone");
		expect(await inputsOf("a-lone")).toEqual([]);
		expect(Number((await t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey: "a-lone" } })).scoreOrgPreClaim)).toBe(0);
	});
});
