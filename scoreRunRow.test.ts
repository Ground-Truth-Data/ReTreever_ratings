import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { fieldPoints, scoreOneProject } from "./projectScore";
import { pairsHash } from "./projectClusters";
import { configHash, openScoreRun, ratingsTree, useScoreDb } from "./scoreDb";
import { rankOnlyOrgs, scoreAndRankOrgs } from "./score_orgs";
import { matrixHash, matrixPoints, METHODOLOGY_VERSION, SCORE_MATRIX } from "./scoreMatrix";
import { score_orgs } from "./score_orgs";
import { rank_projects, score_projects } from "./score_projects";

// What a score run leaves behind on Postgres with ReTreever's real schema:
// one run row, the weights table equal to git, and its id on every score row.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
	useScoreDb(t.prisma);
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => t.close());
beforeEach(async () => {
	await t.reset();
	await t.prisma.stakeholderCategoryTable.createMany({ data: [{ stakeholderCategoryId: "nursery", stakeholderCategoryName: "Nursery" }] });
});

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
			pairsHash: pairsHash([]),
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
	it("stamps the folded pairs: the same answers the same hash, a changed answer another", async () => {
		const answer = (method: string, resolution: string, day: number) =>
			t.prisma.linkCandidateTable.create({
				data: { table: "ProjectTable", keyA: "a-1", keyB: "c-1", method, confidence: 0.9, foundBy: "test", resolution, resolvedAt: new Date(Date.UTC(2026, 10, day)) },
			});
		const stamp = async () => (await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: await openScoreRun(t.prisma) } })).pairsHash;
		await answer("name-place", "sameAs", 10);
		const first = await stamp();
		expect(first).toBe(pairsHash([{ keyA: "a-1", keyB: "c-1", resolution: "sameAs" }]));
		expect(await stamp()).toBe(first);
		await answer("name-geo", "partOf:a-1", 11);
		const second = await stamp();
		expect(second).not.toBe(first);
		await answer("name-desc", "rejected", 12);
		expect(await stamp()).toBe(pairsHash([]));
	});

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
	// A parent: a run scores only the orgs the site serves.
	await db.organizationTable.create({ data: { organizationKey: `o-${projectKey}`, organizationName: "Org", isParent: true, scoreOrgFlag: true } });
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

const runRows = async () =>
	(await t.prisma.scoreRunTable.findMany({ orderBy: [{ at: "asc" }, { scoreRunId: "asc" }] })).map((r) => ({
		scoreRunId: r.scoreRunId,
		finished: r.completedAt !== null,
		reconciled: r.reconciled,
	}));
const projectRun = async (projectKey: string) => [...new Set((await fieldRows(projectKey)).map((r) => r.scoreRunId))];
const snapshotRows = (scoreRunId: string) => t.prisma.scoreSnapshotTable.count({ where: { scoreRunId } });

describe("the project scorer and the organisation scorer after it are one run", () => {
	it("projects then organisations leave one row, finished and reconciled, that every score row names", async () => {
		await seedProject("a-1");
		await seedProject("a-2");
		expect(await score_projects(["a-1", "a-2"])).toEqual([]);
		await rank_projects();
		expect(await runRows()).toMatchObject([{ finished: false, reconciled: null }]);

		expect(await scoreAndRankOrgs()).toEqual([]);
		const runs = await runRows();
		expect(runs).toMatchObject([{ finished: true, reconciled: true }]);
		const { scoreRunId } = runs[0];
		expect(await projectRun("a-1")).toEqual([scoreRunId]);
		expect(await projectRun("a-2")).toEqual([scoreRunId]);
		const inputs = await t.prisma.orgScoreInputTable.findMany({ select: { scoreRunId: true } });
		expect(inputs).toHaveLength(2);
		expect(inputs.every((i) => i.scoreRunId === scoreRunId)).toBe(true);
		// Two orgs and two projects, frozen under the row the project scorer opened.
		expect(await snapshotRows(scoreRunId)).toBe(4);
	});

	it("a project run that died stays unfinished: its rerun opens a row of its own and the orgs join that one", async () => {
		await seedProject("a-1");
		await seedProject("a-2");
		// Died after a-1: a-2 is still flagged, and nothing followed.
		await score_projects(["a-1"]);
		const [died] = await runRows();

		await score_projects(["a-2"]);
		await rank_projects();
		expect(await scoreAndRankOrgs()).toEqual([]);
		const runs = await runRows();
		expect(runs).toMatchObject([
			{ scoreRunId: died.scoreRunId, finished: false, reconciled: null },
			{ finished: true, reconciled: true },
		]);
		// Each project still names the row that scored it.
		expect(await projectRun("a-1")).toEqual([died.scoreRunId]);
		expect(await projectRun("a-2")).toEqual([runs[1].scoreRunId]);
		expect(await snapshotRows(died.scoreRunId)).toBe(0);
	});

	it("with no org dirty after the projects, the org step still completes their run", async () => {
		await t.prisma.projectTable.create({ data: { projectKey: "a-1", projectName: "Alone", scoreProjectFlag: true } });
		await score_projects(["a-1"]);
		await rank_projects();
		expect(await scoreAndRankOrgs()).toEqual([]);
		const runs = await runRows();
		expect(runs).toMatchObject([{ finished: true, reconciled: true }]);
		expect(await snapshotRows(runs[0].scoreRunId)).toBe(1);

		// Nothing scored and nothing left open: no run.
		expect(await scoreAndRankOrgs()).toEqual([]);
		expect(await runRows()).toHaveLength(1);
	});

	it("--rank-only after a project run completes that run", async () => {
		await t.prisma.projectTable.create({ data: { projectKey: "a-1", projectName: "Alone", scoreProjectFlag: true } });
		await score_projects(["a-1"]);
		const [{ scoreRunId }] = await runRows();
		expect(await rankOnlyOrgs()).toBe(scoreRunId);
		expect(await runRows()).toMatchObject([{ scoreRunId, finished: true, reconciled: true }]);
	});

	it("inputs that moved since the project run are another run: the project row stays unfinished", async () => {
		await seedProject("a-1");
		await score_projects(["a-1"]);
		await rank_projects();
		await t.prisma.linkCandidateTable.create({
			data: { table: "ProjectTable", keyA: "a-1", keyB: "c-1", method: "name-place", confidence: 0.9, foundBy: "test", resolution: "sameAs", resolvedAt: new Date() },
		});
		expect(await scoreAndRankOrgs()).toEqual([]);
		expect(await runRows()).toMatchObject([
			{ finished: false, reconciled: null },
			{ finished: true, reconciled: true },
		]);
	});

	it("a run an org was already scored under is never joined", async () => {
		await seedProject("a-1");
		await score_projects(["a-1"]);
		await rank_projects();
		// A named-org run: its own row, org rows stamped, no snapshot.
		expect(await score_orgs(["o-a-1"])).toEqual([]);
		expect(await scoreAndRankOrgs(true)).toEqual([]);
		expect(await runRows()).toMatchObject([
			{ finished: false, reconciled: null },
			{ finished: false, reconciled: null },
			{ finished: true, reconciled: true },
		]);
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
