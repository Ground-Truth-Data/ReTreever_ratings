#!/usr/bin/env tsx
import {
	orgWhere,
	propagateDirtyToParents,
	rankOrgs,
	scoreOneOrg,
} from "./orgScore.js";
import { takeRunLock } from "$parent/src/lib/server/runLock.js";
import { scoreInBatches, withRetry } from "./scoreRun.js";
import { closeScoreDb, scoreConfig as config, scoreDb } from "./scoreDb.js";

/** Returns the organizationKeys that failed even after retries — never throws
 * for one org. */
export async function score_orgs(
	orgIds?: string[],
	batchSize?: number,
	full = false,
): Promise<string[]> {
	const prisma = scoreDb();
	const orgsToScore = orgIds
		? await prisma.organizationTable.findMany({
				where: orgWhere(full, orgIds),
				select: { organizationKey: true },
			})
		: await prisma.organizationTable.findMany({
				where: orgWhere(full),
				select: { organizationKey: true },
				take: batchSize,
				orderBy: { scoreLastUpdatedAt: "asc" },
			});

	console.log(`\n🏢 Scoring ${orgsToScore.length} dirty organizations...`);

	const failed: string[] = [];
	for (const { organizationKey } of orgsToScore) {
		try {
			await withRetry(() => scoreOneOrg(prisma, organizationKey), `score ${organizationKey}`);
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
 * dirties its parent, the dirty rows (every row with `full`) are scored in
 * batches, then every org is re-ranked. Returns the keys that failed. */
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

	const where = orgWhere(full);

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
		(keys) => score_orgs(keys, batchSize, full),
	);
	if (failed.length > 0 && full) {
		console.warn(
			"   --full doesn't track these via a flag — re-run the same --full command to retry just what's still missing.",
		);
	}

	await rankOrgs(prisma);
	return failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rawArgs = process.argv.slice(2);
	// --full ignores scoreOrgFlag and rescores every organization.
	const full = rawArgs.includes("--full");
	const args = rawArgs.filter((a) => a !== "--full");
	const batchSize = args[0]
		? Number.parseInt(args[0], 10)
		: config.batch.organizations.defaultSize;
	const testOrgIds = args.slice(1);

	const lock = await takeRunLock(`score_orgs${full ? " --full" : ""}`).catch((e: Error) => {
		console.error(e.message);
		process.exit(1);
	});
	try {
		if (testOrgIds.length > 0) {
			const prisma = scoreDb();
			await propagateDirtyToParents(prisma);
			const failed = await score_orgs(testOrgIds, batchSize, full);
			if (failed.length > 0) {
				console.warn(
					`\n⚠️  ${failed.length} organization(s) failed after retries:\n  ${failed.join("\n  ")}`,
				);
			}
			await rankOrgs(prisma);
		} else {
			await scoreAndRankOrgs(full, batchSize);
		}
	} finally {
		await lock.release();
		await closeScoreDb();
	}
	process.exit(0);
}
