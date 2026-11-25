import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { openScoreRun } from "./scoreDb";
import { logicDriftLines, NOT_LOGIC_CONFIG, SCORE_LOGIC, scoreLogicDrift } from "./scoreLogic";
import { matrixHash, METHODOLOGY_VERSION } from "./scoreMatrix";

// A logic change is faked in a throwaway git repo holding the scorer's file
// names, against Postgres rows stamped with that repo's commits.

const REAL_CONFIG = readFileSync(fileURLToPath(new URL("./scoreConfig.json", import.meta.url)), "utf8");
const FILES = ["projectScore.ts", "orgScore.ts", "subtree.ts", "projectClusters.ts", "scoreSnapshot.ts", "score_projects.ts", "scoreMatrix.ts", "README.md", "projectScore.test.ts"];

let t: TestDb;
let repo: string;
const git = (...args: string[]) =>
	execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const write = (file: string, text: string) => writeFileSync(join(repo, file), text);
const commit = (message: string) => {
	git("add", "-A");
	git("commit", "-q", "-m", message);
	return git("rev-parse", "HEAD");
};

beforeAll(async () => {
	t = await pgliteDb();
});
afterAll(() => t.close());
beforeEach(async () => {
	await t.reset();
	repo = mkdtempSync(join(tmpdir(), "scoreLogic-"));
	git("init", "-q");
	for (const f of FILES) write(f, `// ${f}\n`);
	write("scoreConfig.json", REAL_CONFIG);
	return () => rmSync(repo, { recursive: true, force: true });
});

async function run(scoreRunId: string, ratingsSha: string, more: { completedAt?: Date; matrixHash?: string; methodologyVersion?: string } = {}) {
	await t.prisma.scoreRunTable.create({
		data: { scoreRunId, at: new Date("2026-11-13T01:06:00Z"), ratingsSha, dirty: false, matrixHash: matrixHash(), configHash: "c", methodologyVersion: METHODOLOGY_VERSION, ...more },
	});
}

async function projectScored(projectKey: string, scoreRunId: string | null, deletedAt: Date | null = null) {
	await t.prisma.projectTable.create({ data: { projectKey, projectName: projectKey, deletedAt } });
	await t.prisma.projectScoreByFieldTable.createMany({
		data: ["projectName", "url"].map((fieldName) => ({
			granularProjectScoreId: `${projectKey}:${fieldName}`,
			projectKey,
			recordTable: "ProjectTable",
			recordKey: projectKey,
			fieldName,
			pointsAvailable: 1,
			isAwarded: true,
			pointsAwarded: 1,
			scoreRunId,
		})),
	});
}

async function orgScored(organizationKey: string, scoreRunId: string | null, deletedAt: Date | null = null) {
	await t.prisma.organizationTable.create({ data: { organizationKey, organizationName: organizationKey, deletedAt } });
	await t.prisma.orgScoreInputTable.create({ data: { organizationKey, projectKey: "a-1", viaOrganizationKeys: [organizationKey], scoredAt: new Date(), scoreRunId } });
}

/** Two projects and an org scored by one finished run at the repo's first commit. */
async function scoredAtFirstCommit(more: Parameters<typeof run>[2] = {}) {
	const sha = commit("first");
	await run("r1", sha, { completedAt: new Date("2026-11-13T02:00:00Z"), ...more });
	await projectScored("a-1", "r1");
	await projectScored("a-2", "r1");
	await orgScored("o-1", "r1");
	return sha;
}

const drift = () => scoreLogicDrift(t.prisma, repo);

describe("scoreLogicDrift", () => {
	it("finds nothing behind while the tree is the commit that scored", async () => {
		const sha = await scoredAtFirstCommit();
		expect(await drift()).toEqual({ treeSha: sha.slice(0, 8), stale: [], unknown: false });
	});

	it("finds nothing behind when only a README, a test and a comment in the weights file moved", async () => {
		await scoredAtFirstCommit();
		write("README.md", "new words\n");
		write("projectScore.test.ts", "// another test\n");
		write("scoreMatrix.ts", "// a comment\n");
		const head = commit("docs and tests");
		expect(await drift()).toEqual({ treeSha: head.slice(0, 8), stale: [], unknown: false });
		expect(logicDriftLines(await drift())).toEqual([]);
	});

	it("names the projects an older projectScore.ts scored, committed or not, and leaves the orgs alone", async () => {
		const sha = await scoredAtFirstCommit();
		write("projectScore.ts", "// a field counts differently\n");
		const uncommitted = await drift();
		expect(uncommitted?.stale).toEqual([
			{
				kind: "project",
				scoreRunId: "r1",
				what: `2 projects, last scored 13 Nov 2026 by run r1 at ${sha.slice(0, 8)}`,
				count: 2,
				why: "projectScore.ts changed",
				fix: "gitEr/CLI.sh score projects --full",
			},
		]);
		commit("project logic");
		expect((await drift())?.stale).toEqual(uncommitted?.stale);
		expect(logicDriftLines(await drift())[1]).toContain("2 projects, last scored 13 Nov 2026 by run r1");
	});

	it("names the orgs and the ranks an older orgScore.ts wrote", async () => {
		await scoredAtFirstCommit();
		write("orgScore.ts", "// claims weigh differently\n");
		commit("org logic");
		expect((await drift())?.stale.map((s) => [s.kind, s.what.split(",")[0], s.why, s.fix])).toEqual([
			["org", "1 organization", "orgScore.ts changed", "gitEr/CLI.sh score orgs --full"],
			["rank", "The ranks of the latest finished run", "orgScore.ts changed", "gitEr/CLI.sh score orgs --rank-only"],
		]);
	});

	it("only the rows a later run did not rewrite stay behind", async () => {
		await scoredAtFirstCommit();
		write("projectScore.ts", "// changed\n");
		const second = commit("project logic");
		await run("r2", second);
		await t.prisma.projectScoreByFieldTable.updateMany({ where: { projectKey: "a-2" }, data: { scoreRunId: "r2" } });
		expect((await drift())?.stale.map((s) => s.what.split(",")[0])).toEqual(["1 project"]);
	});

	it("sees weights that moved in the run's hash and a method that moved in its version", async () => {
		await scoredAtFirstCommit({ matrixHash: "older weights", methodologyVersion: "1" });
		expect((await drift())?.stale.map((s) => [s.kind, s.why])).toEqual([
			["project", "the weights changed"],
			["rank", `the method went from 1 to ${METHODOLOGY_VERSION}`],
		]);
	});

	it("compares scoreConfig.json key by key: a pool size is not logic, a small-category limit is ranking", async () => {
		const then = JSON.parse(REAL_CONFIG);
		write("scoreConfig.json", JSON.stringify({ ...then, pool: { maxConnections: 99 }, minCategoryGroup: then.minCategoryGroup + 1 }));
		await scoredAtFirstCommit();
		expect((await drift())?.stale.map((s) => [s.kind, s.why])).toEqual([["rank", "scoreConfig.json minCategoryGroup changed"]]);
	});

	it("gives every scoreConfig.json key to a kind of score, or lists it as not logic", () => {
		const claimed = [...Object.values(SCORE_LOGIC).flatMap((l) => [...l.config]), ...NOT_LOGIC_CONFIG].sort();
		expect(claimed).toEqual(Object.keys(JSON.parse(REAL_CONFIG)).sort());
	});

	it("counts no soft-deleted project or org, which no run rescores", async () => {
		await scoredAtFirstCommit();
		await projectScored("a-gone", null, new Date());
		await orgScored("o-gone", null, new Date());
		expect((await drift())?.stale).toEqual([]);
	});

	it("names live rows written before runs were recorded", async () => {
		await scoredAtFirstCommit();
		await projectScored("a-old", null);
		expect((await drift())?.stale).toEqual([
			{ kind: "project", scoreRunId: null, what: "1 project, last scored by no recorded run", count: 1, why: "written before score runs were recorded", fix: "gitEr/CLI.sh score projects --full" },
		]);
	});

	it("says nothing of a run whose commit this clone lacks, and marks the answer partial", async () => {
		await scoredAtFirstCommit();
		await run("elsewhere", "f".repeat(40));
		await projectScored("a-3", "elsewhere");
		write("projectScore.ts", "// changed\n");
		const d = await drift();
		expect(d?.unknown).toBe(true);
		expect(d?.stale.map((s) => s.scoreRunId)).toEqual(["r1"]);
	});

	it("is null where there is no git repo of its own to compare with", async () => {
		await scoredAtFirstCommit();
		const inside = join(repo, "nested");
		mkdirSync(inside);
		expect(await scoreLogicDrift(t.prisma, inside)).toBeNull();
		expect(await scoreLogicDrift(t.prisma, join(tmpdir(), "no-such-scorer-dir"))).toBeNull();
		expect(logicDriftLines(null)).toEqual([]);
	});

	it("writes nothing", async () => {
		await scoredAtFirstCommit();
		write("orgScore.ts", "// changed\n");
		const before = await Promise.all([t.prisma.scoreRunTable.findMany(), t.prisma.projectScoreByFieldTable.findMany(), t.prisma.orgScoreInputTable.findMany(), t.prisma.projectTable.findMany(), t.prisma.organizationTable.findMany()]);
		await drift();
		expect(await Promise.all([t.prisma.scoreRunTable.findMany(), t.prisma.projectScoreByFieldTable.findMany(), t.prisma.orgScoreInputTable.findMany(), t.prisma.projectTable.findMany(), t.prisma.organizationTable.findMany()])).toEqual(before);
	});
});

describe("openScoreRun", () => {
	it("opens its run whether or not the logic check can run", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// The folded pairs are the run's own input, read outside the check.
		const check = (sql: TemplateStringsArray, ...values: unknown[]) =>
			sql.join("").includes("LinkCandidateTable") ? t.prisma.$queryRaw(sql, ...values) : Promise.reject(new Error("no raw queries here"));
		const refusing = new Proxy(t.prisma, {
			get: (db, key) => (key === "$queryRaw" ? check : Reflect.get(db, key)),
		});
		const scoreRunId = await openScoreRun(refusing);
		expect(await t.prisma.scoreRunTable.count({ where: { scoreRunId } })).toBe(1);
		expect(warn).not.toHaveBeenCalled();
	});
});
