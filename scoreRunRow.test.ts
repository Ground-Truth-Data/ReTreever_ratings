import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { fieldPoints, scoreOneProject } from "./projectScore";
import { configHash, openScoreRun, ratingsTree, useScoreDb } from "./scoreDb";
import { matrixHash, matrixPoints, METHODOLOGY_VERSION, SCORE_MATRIX } from "./scoreMatrix";
import { score_orgs } from "./score_orgs";
import { score_projects } from "./score_projects";

// What a score run leaves behind on Postgres with ReTreever's real schema:
// one run row, the weights table equal to git, and its id on every score row.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
	useScoreDb(t.prisma);
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const gitRows = Object.entries(SCORE_MATRIX)
	.map(([fieldName, { points, description }]) => ({ fieldName, pointsAvailable: points, description }))
	.sort((a, b) => (a.fieldName < b.fieldName ? -1 : 1));
const tableRows = () =>
	t.prisma.scoreMatrixTable.findMany({
		select: { fieldName: true, pointsAvailable: true, description: true },
		orderBy: { fieldName: "asc" },
	});

describe("openScoreRun", () => {
	it("writes one row naming the commit, the tree's state, both hashes and the method, and mirrors the weights first", async () => {
		const scoreRunId = await openScoreRun(t.prisma);
		const runs = await t.prisma.scoreRunTable.findMany();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			scoreRunId,
			...ratingsTree(),
			matrixHash: matrixHash(),
			configHash: configHash(),
			methodologyVersion: METHODOLOGY_VERSION,
			foundrRunId: null,
			ledgerHash: null,
		});
		expect(runs[0].ratingsSha).toMatch(/^[0-9a-f]{40}$/);
		expect(await tableRows()).toEqual(gitRows);
	});

	it("names the newest Foundr run and hashes its ledgers", async () => {
		const ledgerHashes = { a: "1".repeat(64), c: "2".repeat(64) };
		const run = (runId: string, startedAt: string, hashes: object) =>
			t.prisma.foundrRunTable.create({
				data: { runId, startedAt: new Date(startedAt), foundrSha: "f", retreeverSha: "r", dirty: false, manifest: {}, ledgerHashes: hashes, mapHashes: {} },
			});
		await run("older", "2026-11-09T10:00:00Z", { a: "0".repeat(64) });
		await run("newest", "2026-11-10T10:00:00Z", ledgerHashes);

		await openScoreRun(t.prisma);
		const stored = await t.prisma.foundrRunTable.findUniqueOrThrow({ where: { runId: "newest" } });
		expect(await t.prisma.scoreRunTable.findFirstOrThrow()).toMatchObject({
			foundrRunId: "newest",
			ledgerHash: crypto.createHash("sha256").update(JSON.stringify(stored.ledgerHashes)).digest("hex"),
		});
	});

	// The orchestrator scores inside its run, so the row points at that run even when a later one has opened.
	it("names the Foundr run the process carries over the newest, and none when that run has no row", async () => {
		const run = (runId: string, startedAt: string) =>
			t.prisma.foundrRunTable.create({
				data: { runId, startedAt: new Date(startedAt), foundrSha: "f", retreeverSha: "r", dirty: false, manifest: {}, ledgerHashes: { a: "3".repeat(64) }, mapHashes: {} },
			});
		await run("mine", "2026-11-09T10:00:00Z");
		await run("newest", "2026-11-10T10:00:00Z");
		vi.stubEnv("FOUNDR_RUN_ID", "mine");
		try {
			const first = await openScoreRun(t.prisma);
			expect(await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: first } })).toMatchObject({
				foundrRunId: "mine",
				ledgerHash: crypto.createHash("sha256").update(JSON.stringify({ a: "3".repeat(64) })).digest("hex"),
			});
			vi.stubEnv("FOUNDR_RUN_ID", "never-opened");
			const second = await openScoreRun(t.prisma);
			expect(await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: second } })).toMatchObject({ foundrRunId: null, ledgerHash: null });
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

async function seedProject(projectKey: string) {
	const db = t.prisma;
	await db.projectTable.create({ data: { projectKey, projectName: `Project ${projectKey}`, scoreProjectFlag: true } });
	await db.organizationTable.create({ data: { organizationKey: `o-${projectKey}`, organizationName: "Org", scoreOrgFlag: true } });
	await db.landTable.create({ data: { landKey: `${projectKey}-l1`, landName: "Plot", projectKey, hectares: 3, latitude: 1.5, longitude: 2.5 } });
	await db.polygonTable.create({ data: { polygonKey: `${projectKey}-g1`, landKey: `${projectKey}-l1`, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } } });
	await db.plantingTable.create({ data: { plantingKey: `${projectKey}-t1`, projectKey, parentKey: `${projectKey}-l1`, parentTable: "landTable", plantedQty: 40 } });
	await db.cropTable.create({ data: { cropKey: `${projectKey}-c1`, cropName: "Rhizophora", projectKey } });
	await db.stakeholderTable.create({
		data: { stakeholderKey: `${projectKey}-s1`, organizationKey: `o-${projectKey}`, projectKey, parentKey: projectKey, parentTable: "projectTable", stakeholderCategory: "nursery" },
	});
	await db.sourceTable.create({ data: { sourceKey: `${projectKey}-src`, projectKey, url: "https://x", urlType: "webpage" } });
}

const fieldRows = (projectKey: string) =>
	t.prisma.projectScoreByFieldTable.findMany({
		where: { projectKey },
		select: { fieldName: true, recordKey: true, pointsAwarded: true, pointsAvailable: true, scoreRunId: true },
		orderBy: [{ fieldName: "asc" }, { recordKey: "asc" }],
	});

describe("a rescore is one run, stamped on what it wrote", () => {
	it("score_projects with no run opens one and stamps every by-field row of every project with it", async () => {
		await seedProject("a-1");
		await seedProject("a-2");
		expect(await score_projects(["a-1", "a-2"])).toEqual([]);

		const runs = await t.prisma.scoreRunTable.findMany();
		expect(runs).toHaveLength(1);
		const rows = await t.prisma.projectScoreByFieldTable.findMany({ select: { projectKey: true, scoreRunId: true } });
		expect(rows.length).toBeGreaterThan(0);
		expect(new Set(rows.map((r) => r.projectKey))).toEqual(new Set(["a-1", "a-2"]));
		expect(rows.every((r) => r.scoreRunId === runs[0].scoreRunId)).toBe(true);
	});

	it("score_projects given a run opens none, so a batched run is one row", async () => {
		await seedProject("a-1");
		const scoreRunId = await openScoreRun(t.prisma);
		await score_projects(["a-1"], scoreRunId);
		expect(await t.prisma.scoreRunTable.count()).toBe(1);
		expect((await fieldRows("a-1")).every((r) => r.scoreRunId === scoreRunId)).toBe(true);
	});

	it("score_orgs with no run opens one and stamps every input row with it", async () => {
		await seedProject("a-1");
		await score_projects(["a-1"], await openScoreRun(t.prisma));
		expect(await score_orgs(["o-a-1"])).toEqual([]);

		const runs = await t.prisma.scoreRunTable.findMany({ orderBy: { at: "asc" } });
		expect(runs).toHaveLength(2);
		const inputs = await t.prisma.orgScoreInputTable.findMany({ where: { organizationKey: "o-a-1" } });
		expect(inputs).toHaveLength(1);
		expect(inputs[0].scoreRunId).toBe(runs[1].scoreRunId);
	});
});

describe("a published score can be reproduced from its run", () => {
	it("the same files and inputs give a project the same totals and the same rows", async () => {
		await seedProject("a-1");
		const first = await openScoreRun(t.prisma);
		const points = fieldPoints(matrixPoints(), 1);
		await scoreOneProject(t.prisma, "a-1", points, first);
		const published = await t.prisma.projectTable.findUniqueOrThrow({
			where: { projectKey: "a-1" },
			select: { scoreProject: true, scorePointsScored: true, scorePointsAvailable: true },
		});
		const publishedRows = (await fieldRows("a-1")).map(({ scoreRunId: _, ...r }) => r);
		// Real weights reached the rows: geometry is the 20-point field.
		expect(publishedRows.find((r) => r.fieldName === "PolygonTable.geometry")).toMatchObject({ pointsAwarded: 20, pointsAvailable: 20 });
		expect(published.scorePointsScored).toBe(publishedRows.reduce((n, r) => n + r.pointsAwarded, 0));

		// The run says which weights and config it used; they are the ones in git now.
		const run = await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: first } });
		expect(run.matrixHash).toBe(matrixHash());
		expect(run.configHash).toBe(configHash());

		const again = await openScoreRun(t.prisma);
		await scoreOneProject(t.prisma, "a-1", fieldPoints(matrixPoints(), 1), again);
		const reproduced = await t.prisma.projectTable.findUniqueOrThrow({
			where: { projectKey: "a-1" },
			select: { scoreProject: true, scorePointsScored: true, scorePointsAvailable: true },
		});
		expect(reproduced).toEqual(published);
		expect((await fieldRows("a-1")).map(({ scoreRunId: _, ...r }) => r)).toEqual(publishedRows);
		expect((await fieldRows("a-1")).every((r) => r.scoreRunId === again)).toBe(true);
	});
});
