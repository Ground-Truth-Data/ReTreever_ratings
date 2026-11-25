/**
 * Says when stored scores were written by scorer logic the tree no longer
 * holds. `scoreProjectFlag` and `scoreOrgFlag` track data that moved; nothing
 * else tracks code that moved. Reads only: git and SELECTs. Whatever it cannot
 * tell (no git, another repo, a commit this clone lacks) it leaves unsaid.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import treeConfig from "./scoreConfig.json" with { type: "json" };
import { matrixHash, METHODOLOGY_VERSION } from "./scoreMatrix.js";

const RATINGS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The files and scoreConfig.json keys that decide each kind of stored number,
 * and the command that writes it again. A project's weights are compared by
 * the run's `matrixHash`, the ranking method by its `methodologyVersion`, so
 * scoreMatrix.ts is in no list: a comment there changes no score.
 * `orgScore.ts` holds both the org score and `rankOrgs`.
 */
export const SCORE_LOGIC = {
	project: { files: ["projectScore.ts"], config: ["defaults"], fix: "gitEr/CLI.sh score projects --full" },
	org: { files: ["orgScore.ts", "projectClusters.ts", "subtree.ts"], config: ["plantingOwnerRoles"], fix: "gitEr/CLI.sh score orgs --full" },
	rank: { files: ["orgScore.ts", "score_projects.ts", "scoreSnapshot.ts"], config: ["minCategoryGroup"], fix: "gitEr/CLI.sh score orgs --rank-only" },
} as const;

/** scoreConfig.json keys that change how fast a run goes, never what it writes. */
export const NOT_LOGIC_CONFIG = ["pool", "batch"];

export type LogicKind = keyof typeof SCORE_LOGIC;

export type StaleLogic = {
	kind: LogicKind;
	/** Null for rows written before score runs were recorded. */
	scoreRunId: string | null;
	/** What is behind: "2,592 projects, last scored 13 Nov 2026 by run … at 271d0850". */
	what: string;
	/** The stored rows behind; null for ranks, which belong to one run. */
	count: number | null;
	/** What moved since: "projectScore.ts changed, the weights changed". */
	why: string;
	/** The command that brings it up to the tree. */
	fix: string;
};

export type LogicDrift = {
	/** The commit the tree is on, short. */
	treeSha: string;
	stale: StaleLogic[];
	/** A run's commit is not in this clone, so nothing can be said of what it wrote. */
	unknown: boolean;
};

export type LogicDb = Pick<PrismaClient, "$queryRaw" | "scoreRunTable">;

type Run = { scoreRunId: string; at: Date; ratingsSha: string; matrixHash: string; methodologyVersion: string };
type Git = (...args: string[]) => string;

const gitIn =
	(dir: string): Git =>
	(...args) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const count = (k: number, one: string) => `${k.toLocaleString("en-US")} ${one}${k === 1 ? "" : "s"}`;
const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const by = (run: Run) => `${day(run.at)} by run ${run.scoreRunId} at ${run.ratingsSha.slice(0, 8)}`;

/** What moved between a run's commit and the working tree, for one kind; null when the commit is not here. */
function moved(git: Git, kind: LogicKind, run: Run): string[] | null {
	try {
		git("cat-file", "-e", `${run.ratingsSha}^{commit}`);
	} catch {
		return null;
	}
	const { files, config } = SCORE_LOGIC[kind];
	// Against the working tree, not HEAD: an uncommitted edit is the logic the next run uses.
	const why = git("diff", "--name-only", run.ratingsSha, "--", ...files)
		.split("\n")
		.filter(Boolean)
		.map((f) => `${f} changed`);
	if (kind === "project" && run.matrixHash !== matrixHash()) why.push("the weights changed");
	if (kind === "rank" && run.methodologyVersion !== METHODOLOGY_VERSION) why.push(`the method went from ${run.methodologyVersion} to ${METHODOLOGY_VERSION}`);
	let then: Record<string, unknown> = {};
	try {
		then = JSON.parse(git("show", `${run.ratingsSha}:scoreConfig.json`));
	} catch {
		// No config at that commit: every key the tree has is new since.
	}
	const now: Record<string, unknown> = treeConfig;
	for (const key of config) if (!same(then[key], now[key])) why.push(`scoreConfig.json ${key} changed`);
	return why;
}

/**
 * Compares the runs behind the stored scores with the tree: each live
 * project's by-field rows, each live org's input rows, and the ranks of the
 * latest finished run. Null when `dir` is not a git repo of its own, as on a
 * deployed server, where there is no tree to compare with.
 */
export async function scoreLogicDrift(db: LogicDb, dir: string = RATINGS_DIR): Promise<LogicDrift | null> {
	const git = gitIn(dir);
	let treeSha: string;
	try {
		// Inside another repo (a burner assembly) git answers for that repo, whose commits are not the runs'.
		if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(dir)) return null;
		treeSha = git("rev-parse", "--short=8", "HEAD");
	} catch {
		return null;
	}

	const [projectRuns, orgRuns, finished] = await Promise.all([
		db.$queryRaw<{ scoreRunId: string | null }[]>`SELECT DISTINCT "scoreRunId" FROM "ProjectScoreByFieldTable"`,
		db.$queryRaw<{ scoreRunId: string | null }[]>`SELECT DISTINCT "scoreRunId" FROM "OrgScoreInputTable"`,
		db.scoreRunTable.findFirst({ where: { completedAt: { not: null } }, orderBy: { completedAt: "desc" } }),
	]);
	const ids = [...projectRuns, ...orgRuns].flatMap((r) => (r.scoreRunId ? [r.scoreRunId] : []));
	const runs = new Map((await db.scoreRunTable.findMany({ where: { scoreRunId: { in: ids } } })).map((r) => [r.scoreRunId, r]));

	// Counted only once a run is found behind: a soft-deleted project or org keeps its old rows and is never rescored.
	const live = {
		project: async (id: string | null) =>
			id === null
				? db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT b."projectKey")::int AS n FROM "ProjectScoreByFieldTable" b JOIN "ProjectTable" e ON e."projectKey" = b."projectKey" AND e."deletedAt" IS NULL WHERE b."scoreRunId" IS NULL`
				: db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT b."projectKey")::int AS n FROM "ProjectScoreByFieldTable" b JOIN "ProjectTable" e ON e."projectKey" = b."projectKey" AND e."deletedAt" IS NULL WHERE b."scoreRunId" = ${id}`,
		org: async (id: string | null) =>
			id === null
				? db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT b."organizationKey")::int AS n FROM "OrgScoreInputTable" b JOIN "OrganizationTable" e ON e."organizationKey" = b."organizationKey" AND e."deletedAt" IS NULL WHERE b."scoreRunId" IS NULL`
				: db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT b."organizationKey")::int AS n FROM "OrgScoreInputTable" b JOIN "OrganizationTable" e ON e."organizationKey" = b."organizationKey" AND e."deletedAt" IS NULL WHERE b."scoreRunId" = ${id}`,
	};

	const stale: StaleLogic[] = [];
	let unknown = false;
	for (const [kind, noun, wrote] of [
		["project", "project", projectRuns],
		["org", "organization", orgRuns],
	] as const) {
		for (const { scoreRunId } of wrote) {
			const run = scoreRunId ? runs.get(scoreRunId) : undefined;
			const why = run ? moved(git, kind, run) : ["written before score runs were recorded"];
			if (why === null) unknown = true;
			if (!why?.length) continue;
			const [{ n }] = await live[kind](run ? run.scoreRunId : null);
			if (n === 0) continue;
			stale.push({
				kind,
				scoreRunId: run?.scoreRunId ?? null,
				what: `${count(n, noun)}, last scored ${run ? by(run) : "by no recorded run"}`,
				count: n,
				why: why.join(", "),
				fix: SCORE_LOGIC[kind].fix,
			});
		}
	}
	if (finished) {
		const why = moved(git, "rank", finished);
		if (why === null) unknown = true;
		else if (why.length)
			stale.push({
				kind: "rank",
				scoreRunId: finished.scoreRunId,
				what: `The ranks of the latest finished run, made ${by(finished)}`,
				count: null,
				why: why.join(", "),
				fix: SCORE_LOGIC.rank.fix,
			});
	}
	return { treeSha, stale, unknown };
}

/** The drift as the lines a terminal prints; none when nothing is behind. */
export function logicDriftLines(drift: LogicDrift | null): string[] {
	if (!drift?.stale.length) return [];
	return [
		`⚠️  Some stored scores predate the scorer in the tree (${drift.treeSha}):`,
		...drift.stale.map((s) => `   ${s.what}: ${s.why}. Bring up to the tree: ${s.fix}`),
	];
}
