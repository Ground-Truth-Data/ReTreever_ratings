import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { GOLDEN_ORGS, runGolden, seedGolden } from "./golden.fixture";
import { openScoreRun, useScoreDb } from "./scoreDb";
import { matrixPoints } from "./scoreMatrix";
import { scoreAndRankOrgs } from "./score_orgs";
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
	await db.organizationTable.create({ data: { organizationKey: "o-1", organizationName: "One", scoreOrgFlag: true } });
	await db.organizationTable.create({ data: { organizationKey: "o-2", organizationName: "Two (no projects)", scoreOrgFlag: true } });
	for (const [projectKey, trees] of [["a-1", 40], ["a-2", 0], ["a-3", 7]] as const) {
		await db.projectTable.create({ data: { projectKey, projectName: projectKey, scoreProjectFlag: true } });
		await db.landTable.create({ data: { landKey: `${projectKey}-l`, landName: "Plot", projectKey, hectares: 2 } });
		if (trees) await db.plantingTable.create({ data: { plantingKey: `${projectKey}-t`, projectKey, parentKey: `${projectKey}-l`, parentTable: "landTable", plantedQty: trees } });
		await db.stakeholderTable.create({
			data: { stakeholderKey: `${projectKey}-s`, organizationKey: "o-1", projectKey, parentKey: projectKey, parentTable: "projectTable" },
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
