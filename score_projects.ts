#!/usr/bin/env tsx
import { fieldPoints, scoreOneProject } from "./projectScore.js";
import { takeRunLock } from "$parent/src/lib/server/runLock.js";
import { scoreInBatches, withRetry } from "./scoreRun.js";
import { closeScoreDb, scoreConfig as config, scoreDb } from "./scoreDb.js";
import { seedScoreMatrixIfEmpty } from "./scoreMatrix.js";

const DEFAULT_FIELD_POINTS = config.defaults.fieldPoints;

const SCORE_CONCURRENCY = Math.max(
	1,
	Number.parseInt(process.env.SCORE_CONCURRENCY ?? "", 10) ||
		config.pool.scoreConcurrency,
);

// Seeds from scoreMatrix.ts only when empty — a populated table is never modified here.
async function loadScoreMatrix(): Promise<Map<string, number>> {
	await seedScoreMatrixIfEmpty(scoreDb());

	const rows = await scoreDb().scoreMatrixTable.findMany({
		select: { fieldName: true, pointsAvailable: true },
	});
	return new Map(rows.map((r) => [r.fieldName, r.pointsAvailable]));
}

// Returns projectKeys that failed even after retries — never throws for one project, so a bad row can't take a long run down.
export async function score_projects(projectKeys: string[]): Promise<string[]> {
	console.log(
		`\n📊 Scoring ${projectKeys.length} dirty projects, ${SCORE_CONCURRENCY} at a time...`,
	);
	const points = fieldPoints(await loadScoreMatrix(), DEFAULT_FIELD_POINTS);

	const failed: string[] = [];
	// Workers share only the pool and the orgs two projects have in common: both
	// may set the same scoreOrgFlag, and a deadlock there leaves the project
	// flagged for the next run.
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < projectKeys.length) {
			const projectKey = projectKeys[cursor++];
			try {
				await withRetry(
					() => scoreOneProject(scoreDb(), projectKey, points),
					`score ${projectKey}`,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`❌ Giving up on ${projectKey} after retries: ${msg}`);
				failed.push(projectKey);
			}
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(SCORE_CONCURRENCY, projectKeys.length) },
			worker,
		),
	);

	console.log(
		`✅ Scored ${projectKeys.length - failed.length}/${projectKeys.length} projects` +
			(failed.length ? ` (${failed.length} failed — left flagged dirty for a later run)` : ""),
	);
	return failed;
}

// One PERCENT_RANK() UPDATE (~1s) — ranking is cheap and global, scoring is slow and per-project, so score what changed then re-rank everything.
export async function rank_projects(): Promise<void> {
	console.log("\n📊 Ranking projects...");

	await scoreDb().$executeRawUnsafe(`
        UPDATE "ProjectTable" pt
        SET "scoreProjectRank" = ranked."scoreProjectRank"
        FROM (
            SELECT
                "projectKey",
                ROUND(PERCENT_RANK() OVER (ORDER BY "scoreProject") * 100)::int AS "scoreProjectRank"
            FROM "ProjectTable"
            WHERE "scoreProject" IS NOT NULL
              AND "deletedAt" IS NULL
        ) ranked
        WHERE pt."projectKey" = ranked."projectKey"
    `);

	console.log("✅ Projects ranked");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rawArgs = process.argv.slice(2);
	// --full ignores scoreProjectFlag and rescores every project — for landing a scoring-logic change on already-clean rows.
	const full = rawArgs.includes("--full");
	const args = rawArgs.filter((a) => a !== "--full");
	const batchSize = args[0]
		? Number.parseInt(args[0], 10)
		: config.batch.projects.defaultSize;

	const lock = await takeRunLock(`score_projects${full ? " --full" : ""}`).catch((e: Error) => {
		console.error(e.message);
		process.exit(1);
	});
	try {
		await scoreAll(full, batchSize);
	} finally {
		await lock.release();
		await closeScoreDb();
	}
	process.exit(0);
}

async function scoreAll(full: boolean, batchSize: number): Promise<void> {
	const where = full
		? { deletedAt: null }
		: { deletedAt: null, scoreProjectFlag: true };

	if (full) {
		console.log(
			"\n⚠️  --full: rescoring EVERY project, ignoring scoreProjectFlag.",
		);
	}

	// --full snapshots the target list once: scoring stamps scoreLastUpdatedAt, so a per-batch query would chase a moving target.
	// Dirty mode re-queries: a scored row drops out via scoreProjectFlag, a failed one via notIn.
	const fullTargetKeys = full
		? (
				await scoreDb().projectTable.findMany({
					select: { projectKey: true },
					where,
					orderBy: [{ scoreLastUpdatedAt: "asc" }, { projectKey: "asc" }],
				})
			).map((p) => p.projectKey)
		: null;

	const totalToScore = fullTargetKeys
		? fullTargetKeys.length
		: await scoreDb().projectTable.count({ where });
	console.log(
		`\n📋 Found ${totalToScore} project${full ? "" : " dirty"} to score`,
	);

	if (totalToScore === 0) {
		console.log(full ? "✅ No projects to score" : "✅ No dirty projects to score");
		return;
	}

	const { failed } = await scoreInBatches(
		full ? "projects" : "dirty projects",
		totalToScore,
		async (tried, failed) =>
			fullTargetKeys
				? fullTargetKeys.slice(tried, tried + batchSize)
				: (
						await scoreDb().projectTable.findMany({
							select: { projectKey: true },
							where: { ...where, projectKey: { notIn: failed } },
							take: batchSize,
							orderBy: { scoreLastUpdatedAt: "asc" },
						})
					).map((p) => p.projectKey),
		score_projects,
	);
	if (failed.length > 0 && full) {
		console.warn(
			"   --full doesn't track these via a flag — re-run the same --full command to retry just what's still missing (already-scored rows sort to the back of a fresh snapshot).",
		);
	}

	await rank_projects();
}
