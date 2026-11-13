import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { GOLDEN_ORGS, runGolden, seedGolden } from "./golden.fixture";
import { openScoreRun, useScoreDb } from "./scoreDb";
import { matrixPoints } from "./scoreMatrix";
import { servedOrgWhere } from "$parent/src/lib/core/servedOrgs";
import { clearUnserved, NO_SCORE, rankOrgs } from "./orgScore";
import { rankOnlyOrgs, scoreAndRankOrgs } from "./score_orgs";
import { rank_projects, score_projects } from "./score_projects";
import { snapshotRun } from "./scoreSnapshot";

// A full run, as `npm run score -- --full` makes it, against ReTreever's real
// schema: what it freezes into ScoreSnapshotTable, and when the run may be
// published.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
	useScoreDb(t.prisma);
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => t.close());
beforeEach(() => t.reset());

async function seed() {
	const db = t.prisma;
	await db.organizationTable.create({ data: { organizationKey: "o-1", organizationName: "One", isParent: true, scoreOrgFlag: true } });
	await db.organizationTable.create({ data: { organizationKey: "o-2", organizationName: "Two (no projects)", scoreOrgFlag: true } });
	for (const [projectKey, trees] of [["a-1", 40], ["a-2", 0], ["a-3", 7]] as const) {
		await db.projectTable.create({ data: { projectKey, projectName: projectKey, scoreProjectFlag: true } });
		await db.landTable.create({ data: { landKey: `${projectKey}-l`, landName: "Plot", projectKey, hectares: 2 } });
		if (trees) await db.plantingTable.create({ data: { plantingKey: `${projectKey}-t`, projectKey, parentKey: `${projectKey}-l`, parentTable: "landTable", plantedQty: trees } });
		await db.stakeholderTable.create({
			data: { stakeholderKey: `${projectKey}-s`, organizationKey: "o-1", projectKey, parentKey: projectKey, parentTable: "projectTable", stakeholderCategory: "developer_ish" },
		});
	}
	await db.projectTable.create({ data: { projectKey: "a-gone", projectName: "Gone", deletedAt: new Date() } });
}

/** `npm run score -- --full`: every project, ranked, then every org, ranked and snapshotted. */
async function fullRun(): Promise<string> {
	const keys = (await t.prisma.projectTable.findMany({ where: { deletedAt: null }, select: { projectKey: true }, orderBy: { projectKey: "asc" } })).map((p) => p.projectKey);
	await score_projects(keys);
	await rank_projects();
	expect(await scoreAndRankOrgs(true)).toEqual([]);
	const run = await t.prisma.scoreRunTable.findFirstOrThrow({ where: { completedAt: { not: null } }, orderBy: { completedAt: "desc" } });
	return run.scoreRunId;
}

const snapshotOf = async (scoreRunId: string) =>
	(
		await t.prisma.scoreSnapshotTable.findMany({ where: { scoreRunId }, orderBy: [{ entityTable: "asc" }, { entityKey: "asc" }] })
	).map(({ scoreRunId: _, ...row }) => row);

describe("a full run's snapshot", () => {
	it("freezes every live org and project, reconciles each, and completes the org run", async () => {
		await seed();
		const runId = await fullRun();
		const rows = await snapshotOf(runId);
		expect(rows.map((r) => `${r.entityTable}:${r.entityKey}`)).toEqual(["org:o-1", "org:o-2", "project:a-1", "project:a-2", "project:a-3"]);
		expect(rows.every((r) => r.reconciled)).toBe(true);

		const project = await t.prisma.projectTable.findUniqueOrThrow({ where: { projectKey: "a-1" } });
		expect(rows[2]).toMatchObject({ score: project.scoreProject, pointsScored: project.scorePointsScored });
		expect(Number(rows[2].percentile)).toBe((project.scoreProjectRank ?? 0) / 100);
		const ranks = rows.filter((r) => r.entityTable === "project").sort((a, b) => Number(b.score) - Number(a.score)).map((r) => r.rank);
		expect(ranks[0]).toBe(1);
		expect(ranks).toEqual([...ranks].sort((a, b) => (a ?? 0) - (b ?? 0)));
		const lines = rows[2].breakdown as { recordTable: string; awarded: number }[];
		expect(lines.reduce((s, l) => s + l.awarded, 0)).toBe(project.scorePointsScored);

		const org = await t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey: "o-1" } });
		expect(rows[0]).toMatchObject({ score: org.scoreOrgFinal, preClaim: org.scoreOrgPreClaim, projectsScored: 3, sumPlantedQty: 47 });

		const run = await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: runId } });
		expect(run.completedAt).not.toBeNull();
		expect(run.reconciled).toBe(true);
		expect(run.publishedAt).toBeNull();
		// The project run that came first froze nothing and never completes: only the org run can be published.
		expect(await t.prisma.scoreRunTable.count({ where: { completedAt: null } })).toBe(1);
	});

	it("is the same, byte for byte, when the same data is scored again", async () => {
		await seed();
		const first = await fullRun();
		await t.prisma.projectTable.updateMany({ data: { scoreProjectFlag: true } });
		const second = await fullRun();
		expect(second).not.toBe(first);
		expect(JSON.stringify(await snapshotOf(second))).toBe(JSON.stringify(await snapshotOf(first)));
	});

	it("names a row whose breakdown does not reach its stored points, and the run does not reconcile", async () => {
		await seed();
		await fullRun();
		const [row] = await t.prisma.projectScoreByFieldTable.findMany({ where: { projectKey: "a-3", isAwarded: true }, take: 1 });
		await t.prisma.projectScoreByFieldTable.update({ where: { granularProjectScoreId: row.granularProjectScoreId }, data: { pointsAwarded: row.pointsAwarded + 1 } });

		const runId = await openScoreRun(t.prisma);
		expect(await snapshotRun(t.prisma, runId)).toEqual(["org:o-1", "project:a-3"]);
		expect((await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: runId } })).reconciled).toBe(false);
	});

	it("counts only scored projects in an org's mean of N", async () => {
		await seed();
		await fullRun();
		await t.prisma.orgScoreInputTable.create({
			data: { organizationKey: "o-1", projectKey: "a-gone", viaOrganizationKeys: ["o-1"], scoreProject: null, plantedQty: 0, scoredAt: new Date() },
		});
		const runId = await openScoreRun(t.prisma);
		expect(await snapshotRun(t.prisma, runId)).toEqual([]);
		expect(await t.prisma.scoreSnapshotTable.findUniqueOrThrow({ where: { scoreRunId_entityTable_entityKey: { scoreRunId: runId, entityTable: "org", entityKey: "o-1" } } })).toMatchObject({ projectsScored: 3, reconciled: true });
	});

	it("writes all of a snapshot or none of it", async () => {
		await seed();
		const runId = await fullRun();
		const before = await t.prisma.scoreSnapshotTable.count();
		await expect(snapshotRun(t.prisma, runId)).rejects.toThrow();
		expect(await t.prisma.scoreSnapshotTable.count()).toBe(before);
	});

	it("the golden suite, run end to end twice, freezes the same snapshot byte for byte, and every row reconciles", async () => {
		await seedGolden(t.prisma);
		await runGolden(t.prisma, matrixPoints(), "golden-1");
		expect(await snapshotRun(t.prisma, "golden-1")).toEqual([]);
		await runGolden(t.prisma, matrixPoints(), "golden-2");
		expect(await snapshotRun(t.prisma, "golden-2")).toEqual([]);

		const first = await snapshotOf("golden-1");
		expect(first.filter((r) => r.entityTable === "org").map((r) => r.entityKey)).toEqual(GOLDEN_ORGS.map((o) => `g-${o}`).sort());
		expect(JSON.stringify(await snapshotOf("golden-2"))).toBe(JSON.stringify(first));
	});
});

/** Served orgs already scored, as a scoring run leaves them: four developers, two producers, one with no category, one reviewed developer. */
async function seedScored() {
	const org = (organizationKey: string, scoreOrgFinal: number, primaryStakeholderCategory: string | null, scoreCohort = "unreviewed") =>
		({ organizationKey, organizationName: organizationKey, isParent: true, scoreOrgFinal, scorePointsScored: 0, scoreCohort, primaryStakeholderCategory, scoreOrgFlag: false });
	await t.prisma.organizationTable.createMany({
		data: [
			org("d-1", 0.9, "developer_ish"),
			org("d-2", 0.5, "developer_ish"),
			org("d-3", 0.5, "developer_ish"),
			org("d-4", 0.1, "developer_ish"),
			org("p-1", 0.2, "producer_ish"),
			org("p-2", 0.8, "producer_ish"),
			org("n-1", 0.3, null),
			org("r-1", 0.05, "developer_ish", "reviewed"),
			{ organizationKey: "c-1", organizationName: "c-1", isParent: false, organizationParentKey: "d-1", scoreOrgFlag: false },
		],
	});
}

const ranksOf = async () =>
	Object.fromEntries(
		(await t.prisma.organizationTable.findMany({ where: { scoreOrgFinal: { not: null } }, select: { organizationKey: true, scoreRank: true, scorePercentile: true } })).map((o) => [
			o.organizationKey,
			[o.scoreRank, Number(o.scorePercentile)],
		]),
	);

describe("an org is ranked among its own cohort and category", () => {
	it("ranks and places each served org within its cohort and primary category; one with no category ranks among the others with none", async () => {
		await seedScored();
		await rankOrgs(t.prisma, servedOrgWhere());
		expect(await ranksOf()).toEqual({
			"d-1": [1, 1],
			"d-2": [2, 0.75],
			"d-3": [2, 0.75],
			"d-4": [4, 0.25],
			"p-2": [1, 1],
			"p-1": [2, 0.5],
			"n-1": [1, 1],
			// Alone in its cohort: the unreviewed developers above it never outrank it.
			"r-1": [1, 1],
		});
	});

	it("--rank-only re-ranks and freezes today's scores as a completed run, each org's category beside its rank, scoring nothing", async () => {
		await seedScored();
		const before = await t.prisma.organizationTable.findMany({ select: { organizationKey: true, scoreOrgFinal: true, scoreLastUpdatedAt: true }, orderBy: { organizationKey: "asc" } });
		const runId = await rankOnlyOrgs();

		const run = await t.prisma.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId: runId } });
		expect(run.completedAt).not.toBeNull();
		expect(run.reconciled).toBe(true);
		expect(await t.prisma.organizationTable.findMany({ select: { organizationKey: true, scoreOrgFinal: true, scoreLastUpdatedAt: true }, orderBy: { organizationKey: "asc" } })).toEqual(before);
		expect(await t.prisma.orgScoreInputTable.count()).toBe(0);

		const frozen = await t.prisma.scoreSnapshotTable.findMany({ where: { scoreRunId: runId, entityTable: "org" }, select: { entityKey: true, rank: true, category: true, cohort: true }, orderBy: { entityKey: "asc" } });
		expect(frozen).toEqual([
			{ entityKey: "c-1", rank: null, category: null, cohort: null },
			{ entityKey: "d-1", rank: 1, category: "developer_ish", cohort: "unreviewed" },
			{ entityKey: "d-2", rank: 2, category: "developer_ish", cohort: "unreviewed" },
			{ entityKey: "d-3", rank: 2, category: "developer_ish", cohort: "unreviewed" },
			{ entityKey: "d-4", rank: 4, category: "developer_ish", cohort: "unreviewed" },
			{ entityKey: "n-1", rank: 1, category: null, cohort: "unreviewed" },
			{ entityKey: "p-1", rank: 2, category: "producer_ish", cohort: "unreviewed" },
			{ entityKey: "p-2", rank: 1, category: "producer_ish", cohort: "unreviewed" },
			{ entityKey: "r-1", rank: 1, category: "developer_ish", cohort: "reviewed" },
		]);
	});

	it("--rank-only refuses while a served org is dirty, or a child dirties one, and opens no run", async () => {
		await seedScored();
		await t.prisma.organizationTable.update({ where: { organizationKey: "p-1" }, data: { scoreOrgFlag: true } });
		await expect(rankOnlyOrgs()).rejects.toThrow(/--rank-only refused: 1 served organization/);

		await t.prisma.organizationTable.update({ where: { organizationKey: "p-1" }, data: { scoreOrgFlag: false } });
		await t.prisma.organizationTable.update({ where: { organizationKey: "c-1" }, data: { scoreOrgFlag: true } });
		await expect(rankOnlyOrgs()).rejects.toThrow(/--rank-only refused: 1 served organization/);
		expect(await t.prisma.scoreRunTable.count()).toBe(0);
	});

	it("a project's snapshot row carries no category", async () => {
		await seed();
		const runId = await fullRun();
		expect(await t.prisma.scoreSnapshotTable.findMany({ where: { scoreRunId: runId, entityTable: "project" }, select: { category: true } })).toEqual([{ category: null }, { category: null }, { category: null }]);
		// o-1's projects name it developer: its row freezes that beside its rank among developers.
		expect(await t.prisma.scoreSnapshotTable.findUniqueOrThrow({ where: { scoreRunId_entityTable_entityKey: { scoreRunId: runId, entityTable: "org", entityKey: "o-1" } }, select: { category: true, rank: true } })).toEqual({ category: "developer_ish", rank: 1 });
	});
});

/** A served parent with a project, a listing the site does not serve still carrying a stale score, its inputs and a dirty flag, a child, and a soft-deleted org. */
async function seedScopes() {
	await seed();
	const stale = { scoreOrgFinal: 0.4, scoreOrgPreClaim: 0.4, scorePointsScored: 3, scorePointsAvailable: 9, scorePercentile: 0.5, scoreRank: 2, scoreCohort: "unreviewed", primaryStakeholderCategory: "producer_ish" };
	await t.prisma.organizationTable.createMany({
		data: [
			{ organizationKey: "l-1", organizationName: "Listing", scoreOrgFlag: true, ...stale },
			{ organizationKey: "c-1", organizationName: "Child", organizationParentKey: "o-1", scoreOrgFlag: true },
			{ organizationKey: "d-1", organizationName: "Deleted", deletedAt: new Date("2026-09-01"), ...stale },
		],
	});
	await t.prisma.stakeholderTable.create({
		data: { stakeholderKey: "l-1-s", organizationKey: "l-1", projectKey: "a-1", parentKey: "a-1", parentTable: "projectTable", stakeholderCategory: "producer_ish" },
	});
	await t.prisma.orgScoreInputTable.createMany({
		data: ["l-1", "d-1"].map((organizationKey) => ({ organizationKey, projectKey: "a-1", viaOrganizationKeys: [organizationKey], scoreProject: 0.4, plantedQty: 0, scoredAt: new Date() })),
	});
}

const orgRow = (organizationKey: string) => t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey } });
const inputsOf = (organizationKey: string) => t.prisma.orgScoreInputTable.count({ where: { organizationKey } });

describe("a run scores only the orgs the site serves", () => {
	afterEach(() => vi.unstubAllEnvs());

	for (const full of [false, true]) {
		it(`a ${full ? "full" : "dirty"} run clears a live org the site does not serve, scores the served one, and leaves a deleted one alone`, async () => {
			await seedScopes();
			const keys = (await t.prisma.projectTable.findMany({ where: { deletedAt: null }, select: { projectKey: true } })).map((p) => p.projectKey);
			await score_projects(keys);
			await rank_projects();
			expect(await scoreAndRankOrgs(full)).toEqual([]);

			expect(await orgRow("l-1")).toMatchObject({ ...NO_SCORE, scoreOrgFlag: false });
			expect(await inputsOf("l-1")).toBe(0);
			expect(await orgRow("c-1")).toMatchObject({ ...NO_SCORE, scoreOrgFlag: false });
			expect(await orgRow("o-1")).toMatchObject({ scoreOrgFlag: false, scoreRank: 1, primaryStakeholderCategory: "developer_ish" });
			expect((await orgRow("o-1")).scoreOrgFinal).not.toBeNull();
			// Soft-deleted: no run touches it, served or not.
			expect(Number((await orgRow("d-1")).scoreOrgFinal)).toBe(0.4);
			expect(await inputsOf("d-1")).toBe(1);
		});
	}

	it("the scope is the site's: WHO_ORG_SCOPE=all serves the listing, so the run scores it instead of clearing it", async () => {
		vi.stubEnv("WHO_ORG_SCOPE", "all");
		await seedScopes();
		const keys = (await t.prisma.projectTable.findMany({ where: { deletedAt: null }, select: { projectKey: true } })).map((p) => p.projectKey);
		await score_projects(keys);
		await rank_projects();
		expect(await scoreAndRankOrgs(false)).toEqual([]);

		const listing = await orgRow("l-1");
		expect(listing.scoreOrgFlag).toBe(false);
		expect(listing.scoreOrgFinal).not.toBeNull();
		expect(listing.scoreRank).toBe(1);
		expect(await inputsOf("l-1")).toBe(1);
	});

	it("a second run clears nothing more", async () => {
		await seedScopes();
		const served = servedOrgWhere();
		expect(await clearUnserved(t.prisma, served)).toBe(3);
		expect(await clearUnserved(t.prisma, served)).toBe(0);
	});
});
