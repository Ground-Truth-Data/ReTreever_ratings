import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";

export type SnapshotDb = Pick<PrismaClient, "$transaction" | "$executeRaw" | "$executeRawUnsafe" | "scoreSnapshotTable">;

/** One recordTable's by-field points summed, as the public tally groups them. */
export type BreakdownLine = { recordTable: string; awarded: number; available: number };

// A project's by-field rows grouped by recordTable; an org's over the projects
// it averaged that carry a score, which is the N its "mean of N" names.
const PROJECT_LINES = `
	SELECT "projectKey" AS key, "recordTable", SUM("pointsAwarded")::int AS awarded, SUM("pointsAvailable")::int AS available
	FROM "ProjectScoreByFieldTable"
	GROUP BY 1, 2`;

const ORG_LINES = `
	SELECT i."organizationKey" AS key, b."recordTable", SUM(b."pointsAwarded")::int AS awarded, SUM(b."pointsAvailable")::int AS available
	FROM "OrgScoreInputTable" i
	JOIN "ProjectScoreByFieldTable" b ON b."projectKey" = i."projectKey"
	WHERE i."scoreProject" IS NOT NULL
	GROUP BY 1, 2`;

const breakdownOf = (lines: string) => `
	SELECT key,
		jsonb_agg(jsonb_build_object('recordTable', "recordTable", 'awarded', awarded, 'available', available) ORDER BY "recordTable") AS breakdown,
		SUM(awarded)::int AS awarded
	FROM (${lines}) l
	GROUP BY key`;

/**
 * Freezes what the run left on the entity rows into ScoreSnapshotTable, checks
 * each row's tally, and marks the run completed — one transaction, so a run is
 * either whole in the snapshot or absent from it. A row reconciles when its
 * breakdown sums to its stored points and, for an org, its pre-claim score is
 * the points-weighted mean of the scored projects it averaged. Unscored rows
 * reconcile: they show no breakdown. A project's percentile is the PERCENT_RANK
 * rank_projects stored; its rank, 1 = best, is counted here. An org's
 * percentile and rank are rankOrgs', within its cohort and the category frozen
 * beside them. Returns the keys that did not reconcile.
 */
export async function snapshotRun(db: SnapshotDb, scoreRunId: string): Promise<string[]> {
	await db.$transaction([
		db.$executeRawUnsafe(
			`INSERT INTO "ScoreSnapshotTable"
				("scoreRunId", "entityTable", "entityKey", "score", "percentile", "rank", "pointsScored", "pointsAvailable", "breakdown", "reconciled")
			SELECT $1, 'project', p."projectKey", p."scoreProject", p."scoreProjectRank" / 100.0,
				CASE WHEN p."scoreProject" IS NOT NULL THEN RANK() OVER (ORDER BY p."scoreProject" DESC NULLS LAST) END,
				p."scorePointsScored", p."scorePointsAvailable",
				b.breakdown,
				p."scoreProject" IS NULL OR COALESCE(b.awarded, 0) IS NOT DISTINCT FROM p."scorePointsScored"
			FROM "ProjectTable" p
			LEFT JOIN (${breakdownOf(PROJECT_LINES)}) b ON b.key = p."projectKey"
			WHERE p."deletedAt" IS NULL`,
			scoreRunId,
		),
		db.$executeRawUnsafe(
			`INSERT INTO "ScoreSnapshotTable"
				("scoreRunId", "entityTable", "entityKey", "score", "percentile", "rank", "cohort", "category", "ratioDisclosure", "pointsScored", "pointsAvailable",
				 "preClaim", "projectsScored", "sumClaimed", "sumPlantedQty", "sumUndisclosed", "breakdown", "reconciled")
			SELECT $1, 'org', o."organizationKey", o."scoreOrgFinal", o."scorePercentile", o."scoreRank", o."scoreCohort", o."primaryStakeholderCategory", o."scoreRatioDisclosure",
				o."scorePointsScored", o."scorePointsAvailable", o."scoreOrgPreClaim", COALESCE(n.scored, 0),
				o."scoreSumClaimed", o."scoreSumPlantedQty", o."scoreSumUndisclosed",
				b.breakdown,
				o."scoreOrgFinal" IS NULL OR (
					COALESCE(b.awarded, 0) IS NOT DISTINCT FROM o."scorePointsScored"
					AND (n.mean IS NULL OR ABS(o."scoreOrgPreClaim" - n.mean) < 1e-9)
				)
			FROM "OrganizationTable" o
			LEFT JOIN (${breakdownOf(ORG_LINES)}) b ON b.key = o."organizationKey"
			LEFT JOIN (
				SELECT "organizationKey", COUNT(*)::int AS scored,
					SUM("scoreProject" * "scorePointsAvailable") / NULLIF(SUM("scorePointsAvailable") FILTER (WHERE "scorePointsAvailable" > 0), 0) AS mean
				FROM "OrgScoreInputTable" WHERE "scoreProject" IS NOT NULL GROUP BY 1
			) n ON n."organizationKey" = o."organizationKey"
			WHERE o."deletedAt" IS NULL`,
			scoreRunId,
		),
		db.$executeRaw`
			UPDATE "ScoreRunTable"
			SET "completedAt" = now(),
				"reconciled" = NOT EXISTS (
					SELECT 1 FROM "ScoreSnapshotTable" s WHERE s."scoreRunId" = ${scoreRunId} AND NOT s."reconciled"
				)
			WHERE "scoreRunId" = ${scoreRunId}`,
		],
		// Freezing every project and org takes ~30 s on dev, far past Prisma's 5 s default.
		{ timeout: 600_000, maxWait: 60_000 },
	);
	const drifted = await db.scoreSnapshotTable.findMany({
		where: { scoreRunId, reconciled: false },
		select: { entityTable: true, entityKey: true },
		orderBy: [{ entityTable: "asc" }, { entityKey: "asc" }],
	});
	return drifted.map((d) => `${d.entityTable}:${d.entityKey}`);
}
