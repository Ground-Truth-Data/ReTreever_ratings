import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { scoreOneOrg } from "./orgScore";
import { clustersOf } from "./projectClusters";

// The org scorer against Postgres with project pairs a person answered: a
// planting listed twice inside one family counts once.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12));

const org = (organizationKey: string, organizationParentKey: string | null = null) =>
	t.prisma.organizationTable.create({ data: { organizationKey, organizationName: organizationKey, organizationParentKey } });

async function project(projectKey: string, organizationKey: string, scoreProject: number, scored: number, available: number, planted: number) {
	await t.prisma.projectTable.create({ data: { projectKey, projectName: projectKey, scoreProject, scorePointsScored: scored, scorePointsAvailable: available } });
	await t.prisma.stakeholderTable.create({
		data: { stakeholderKey: `s-${projectKey}`, organizationKey, projectKey, parentKey: projectKey, parentTable: "projectTable", stakeholderCategory: "developer" },
	});
	await t.prisma.plantingTable.create({ data: { plantingKey: `t-${projectKey}`, projectKey, parentKey: projectKey, parentTable: "projectTable", plantedQty: planted } });
}

const pair = (keyA: string, keyB: string, resolution: string | null, resolvedAt = at(10), method = "name-place") =>
	t.prisma.linkCandidateTable.create({
		data: { table: "ProjectTable", keyA, keyB, method, confidence: 0.9, foundBy: "test", resolution, resolvedAt: resolution ? resolvedAt : null },
	});

/** Eden: a parent over two listings of one mangrove planting, a-1 and c-1, and c-2, Eden's alone. */
async function seedEden() {
	await org("p-eden");
	await org("a-eden", "p-eden");
	await org("c-eden", "p-eden");
	await project("a-1", "a-eden", 0.5, 5, 10, 100);
	await project("c-1", "c-eden", 0.75, 3, 4, 100);
	await project("c-2", "c-eden", 1, 8, 8, 40);
}

async function stored(organizationKey: string) {
	const o = await t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey } });
	return { mean: Number(o.scoreOrgPreClaim), scored: o.scorePointsScored, available: o.scorePointsAvailable, planted: o.scoreSumPlantedQty };
}

const inputs = async (organizationKey: string) =>
	(await t.prisma.orgScoreInputTable.findMany({ where: { organizationKey }, orderBy: { projectKey: "asc" } })).map((i) => [
		i.projectKey,
		i.viaOrganizationKeys,
		i.scoreProject === null ? null : Number(i.scoreProject),
		i.scorePointsScored,
		i.scorePointsAvailable,
		i.plantedQty,
	]);

describe("scoreOneOrg folds the listings a person called one planting", () => {
	it("two sameAs listings in one family: one row under the first key, at their mean, their trees once, via's union", async () => {
		await seedEden();
		await pair("a-1", "c-1", "sameAs");
		await scoreOneOrg(t.prisma, "p-eden", "run-1");
		expect(await inputs("p-eden")).toEqual([
			["a-1", ["a-eden", "c-eden"], 0.625, 4, 7, 100],
			["c-2", ["c-eden"], 1, 8, 8, 40],
		]);
		// Weighted by points available: (0.625 × 7 + 1 × 8) / 15.
		expect(await stored("p-eden")).toEqual({ mean: 0.825, scored: 12, available: 15, planted: 140 });
	});

	it("a part takes its whole's trees, the larger", async () => {
		await org("a-x");
		await project("x-part", "a-x", 0.75, 8, 10, 120);
		await project("x-whole", "a-x", 0.25, 4, 10, 500);
		await pair("x-part", "x-whole", "partOf:x-whole");
		await scoreOneOrg(t.prisma, "a-x", "run-1");
		expect(await inputs("a-x")).toEqual([["x-part", ["a-x"], 0.5, 6, 10, 500]]);
	});

	it("a pair whose sides sit in two unlinked families changes neither", async () => {
		await org("a-lone");
		await org("c-other");
		await project("a-9", "a-lone", 0.2, 2, 10, 30);
		await project("c-9", "c-other", 0.6, 6, 10, 70);
		await pair("a-9", "c-9", "sameAs");
		for (const k of ["a-lone", "c-other"]) await scoreOneOrg(t.prisma, k, "run-1");
		expect(await inputs("a-lone")).toEqual([["a-9", ["a-lone"], 0.2, 2, 10, 30]]);
		expect(await inputs("c-other")).toEqual([["c-9", ["c-other"], 0.6, 6, 10, 70]]);
	});

	it("rejected folds nothing; a later rejection on another row unfolds; Jev's refusal is no answer", async () => {
		await seedEden();
		await pair("a-1", "c-1", "rejected");
		await scoreOneOrg(t.prisma, "p-eden", "run-1");
		expect((await inputs("p-eden")).map((i) => i[0])).toEqual(["a-1", "c-1", "c-2"]);

		await pair("a-1", "c-2", "sameAs", at(10));
		await pair("a-1", "c-2", "rejected", at(11), "name-trgm");
		await pair("a-1", "c-2", "refused", at(12), "jev-1");
		await scoreOneOrg(t.prisma, "p-eden", "run-1");
		expect((await inputs("p-eden")).map((i) => i[0])).toEqual(["a-1", "c-1", "c-2"]);
	});

	it("a rejected pair splits nothing two others joined", async () => {
		await seedEden();
		await pair("a-1", "c-1", "sameAs");
		await pair("c-1", "c-2", "sameAs");
		await pair("a-1", "c-2", "rejected", at(11));
		await scoreOneOrg(t.prisma, "p-eden", "run-1");
		expect(await inputs("p-eden")).toEqual([["a-1", ["a-eden", "c-eden"], 0.75, 5, 7, 100]]);
	});

	it("an org with no folded pair stores exactly what it stored with no pairs at all", async () => {
		await seedEden();
		const snapshot = async () => ({
			org: await t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey: "p-eden" }, omit: { scoreLastUpdatedAt: true } }),
			inputs: await t.prisma.orgScoreInputTable.findMany({ where: { organizationKey: "p-eden" }, omit: { scoredAt: true }, orderBy: { projectKey: "asc" } }),
		});
		await scoreOneOrg(t.prisma, "p-eden", "run-1");
		const before = await snapshot();

		await pair("a-1", "c-1", null);
		await pair("a-1", "c-2", "rejected");
		await pair("c-2", "z-elsewhere", "sameAs");
		await scoreOneOrg(t.prisma, "p-eden", "run-1");
		expect(await snapshot()).toEqual(before);
	});
});

describe("clustersOf", () => {
	it("joins a chain through a key outside the set, and keeps each cluster sorted", () => {
		const pairs = [
			{ keyA: "b", keyB: "z", resolution: "sameAs" },
			{ keyA: "a", keyB: "z", resolution: "partOf:z" },
		];
		expect(clustersOf(["d", "b", "a"], pairs)).toEqual([["a", "b"], ["d"]]);
	});
});
