#!/usr/bin/env tsx
import {
	clearUnserved,
	orgWhere,
	propagateDirtyToParents,
	rankOrgs,
	scoreOneOrg,
} from "./orgScore.js";
import { servedOrgWhere } from "$parent/src/lib/core/servedOrgs.js";
import { takeRunLock } from "$parent/src/lib/server/runLock.js";
import { scoreInBatches, withRetry } from "./scoreRun.js";
import { snapshotRun } from "./scoreSnapshot.js";
import { closeScoreDb, openScoreRun, scoreConfig as config, scoreDb } from "./scoreDb.js";

/** Returns the organizationKeys that failed even after retries — never throws
 * for one org. A call with no run is a run of its own; scoreAndRankOrgs opens
 * one for all its batches. */
export async function score_orgs(
	orgIds?: string[],
	batchSize?: number,
	full = false,
	scoreRunId?: string,
): Promise<string[]> {
	const prisma = scoreDb();
	const runId = scoreRunId ?? (await openScoreRun(prisma));
	const orgsToScore = orgIds
		? await prisma.organizationTable.findMany({
				where: orgWhere(full, servedOrgWhere(), orgIds),
				select: { organizationKey: true },
			})
		: await prisma.organizationTable.findMany({
				where: orgWhere(full, servedOrgWhere()),
				select: { organizationKey: true },
				take: batchSize,
				orderBy: { scoreLastUpdatedAt: "asc" },
			});

	console.log(`\n🏢 Scoring ${orgsToScore.length} dirty organizations...`);

	const failed: string[] = [];
	for (const { organizationKey } of orgsToScore) {
		try {
			await withRetry(() => scoreOneOrg(prisma, organizationKey, runId), `score ${organizationKey}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`❌ Giving up on ${organizationKey} after retries: ${msg}`);
			failed.push(organizationKey);
		}
	}

	console.log(
		`✅ Scored ${orgsToScore.length - failed.length}/${orgsToScore.length} organizations` +
			(failed.length ? ` (${failed.length} failed — left flagged dirty for a later run)` : ""),
	);
	return failed;
}

/** The org run `npm run score` and Foundr's orchestrator share: a dirty child
 * dirties its parent, every org the site does not serve is cleared, the dirty
 * served rows (every served row with `full`) are scored in batches, then the
 * served orgs are re-ranked. Returns the keys that failed. */
export async function scoreAndRankOrgs(
	full = false,
	batchSize: number = config.batch.organizations.defaultSize,
): Promise<string[]> {
	if (full) {
		console.log(
			"\n⚠️  --full: rescoring EVERY organization, ignoring scoreOrgFlag.",
		);
	}

	const prisma = scoreDb();
	const dirtiedParents = await propagateDirtyToParents(prisma);
	if (dirtiedParents > 0) {
		console.log(`\n⬆️  ${dirtiedParents} parent organization(s) dirtied by a dirty child`);
	}

	const served = servedOrgWhere();
	const cleared = await clearUnserved(prisma, served);
	if (cleared > 0) console.log(`\n🧹 ${cleared} organization(s) the site does not serve cleared of their scores`);

	const where = orgWhere(full, served);

	// --full snapshots the target list once: score_orgs() stamps
	// scoreLastUpdatedAt, so a cursor on it would chase a moving target.
	const fullTargetKeys = full
		? (
				await prisma.organizationTable.findMany({
					select: { organizationKey: true },
					where,
					orderBy: [{ scoreLastUpdatedAt: "asc" }, { organizationKey: "asc" }],
				})
			).map((o) => o.organizationKey)
		: null;

	const totalToScore = fullTargetKeys
		? fullTargetKeys.length
		: await prisma.organizationTable.count({ where });
	console.log(
		`\n📋 Found ${totalToScore} organization${full ? "" : " dirty"} to score`,
	);

	// Opened by the first batch with keys, so a run that scores nothing records no run.
	let scoreRunId: string | undefined;
	const { failed } = await scoreInBatches(
		full ? "organizations" : "dirty organizations",
		totalToScore,
		async (tried, failed) =>
			fullTargetKeys
				? fullTargetKeys.slice(tried, tried + batchSize)
				: (
						await prisma.organizationTable.findMany({
							where: { ...where, organizationKey: { notIn: failed } },
							select: { organizationKey: true },
							take: batchSize,
							orderBy: { scoreLastUpdatedAt: "asc" },
						})
					).map((o) => o.organizationKey),
		async (keys) => score_orgs(keys, batchSize, full, (scoreRunId ??= await openScoreRun(prisma))),
	);
	if (failed.length > 0 && full) {
		console.warn(
			"   --full doesn't track these via a flag — re-run the same --full command to retry just what's still missing.",
		);
	}

	await rankOrgs(prisma, served);
	// A run with a failed org left it on its old score: not a whole run, so never completed or publishable.
	if (scoreRunId && failed.length === 0) {
		const drifted = await snapshotRun(prisma, scoreRunId);
		console.log(`\n📸 Snapshot of run ${scoreRunId} written${drifted.length ? `; ${drifted.length} rows do not reconcile:\n  ${drifted.join("\n  ")}` : ", every row reconciles"}`);
	}
	return failed;
}

/** A run that scores nothing: today's scores re-ranked and frozen as a run of
 * their own, in minutes where a full org run takes hours. Refuses while a
 * served org is dirty, so it never freezes a score its inputs have moved past;
 * a dirty child dirties its parent first, as a scoring run would. Returns the
 * run's id. */
export async function rankOnlyOrgs(): Promise<string> {
	const prisma = scoreDb();
	await propagateDirtyToParents(prisma);
	const dirty = await prisma.organizationTable.count({ where: { AND: [servedOrgWhere(), { scoreOrgFlag: true }] } });
	if (dirty > 0) {
		throw new Error(`--rank-only refused: ${dirty} served organization(s) are flagged dirty. Score them first: gitEr/CLI.sh score orgs`);
	}
	const scoreRunId = await openScoreRun(prisma);
	await rankOrgs(prisma, servedOrgWhere());
	const drifted = await snapshotRun(prisma, scoreRunId);
	console.log(`\n📸 Rank-only run ${scoreRunId} written${drifted.length ? `; ${drifted.length} rows do not reconcile:\n  ${drifted.join("\n  ")}` : ", every row reconciles"}`);
	return scoreRunId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rawArgs = process.argv.slice(2);
	// --full ignores scoreOrgFlag and rescores every organization.
	const full = rawArgs.includes("--full");
	const rankOnly = rawArgs.includes("--rank-only");
	if (full && rankOnly) {
		console.error("--full and --rank-only contradict: one rescores everything, the other scores nothing.");
		process.exit(1);
	}
	const args = rawArgs.filter((a) => a !== "--full" && a !== "--rank-only");
	const batchSize = args[0]
		? Number.parseInt(args[0], 10)
		: config.batch.organizations.defaultSize;
	const testOrgIds = args.slice(1);

	const lock = await takeRunLock(`score_orgs${full ? " --full" : rankOnly ? " --rank-only" : ""}`).catch((e: Error) => {
		console.error(e.message);
		process.exit(1);
	});
	let code = 0;
	try {
		if (rankOnly) {
			await rankOnlyOrgs().catch((e: Error) => {
				console.error(`❌ ${e.message}`);
				code = 1;
			});
		} else if (testOrgIds.length > 0) {
			const prisma = scoreDb();
			await propagateDirtyToParents(prisma);
			const failed = await score_orgs(testOrgIds, batchSize, full);
			if (failed.length > 0) {
				console.warn(
					`\n⚠️  ${failed.length} organization(s) failed after retries:\n  ${failed.join("\n  ")}`,
				);
			}
			await rankOrgs(prisma, servedOrgWhere());
		} else {
			await scoreAndRankOrgs(full, batchSize);
		}
	} finally {
		await lock.release();
		await closeScoreDb();
	}
	process.exit(code);
}
