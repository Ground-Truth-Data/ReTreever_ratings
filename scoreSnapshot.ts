import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { ALL_GROUP, MIN_CATEGORY_GROUP } from "./orgScore.js";
import { clustersOf, foldPairs } from "./projectClusters.js";

export type SnapshotDb = Pick<PrismaClient, "$transaction" | "$executeRaw" | "$executeRawUnsafe" | "$queryRaw" | "scoreSnapshotTable">;

/** One recordTable's by-field points summed, as the public tally groups them. */
export type BreakdownLine = { recordTable: string; awarded: number; available: number };

// A project's by-field rows grouped by recordTable; an org's over the projects
// it averaged that carry a score, which is the N its "mean of N" names.
const PROJECT_LINES = `
	SELECT "projectKey" AS key, "recordTable", SUM("pointsAwarded")::int AS awarded, SUM("pointsAvailable")::int AS available
	FROM "ProjectScoreByFieldTable"
	GROUP BY 1, 2`;

// A folded input row stands for the scored live members of its fold component
// ($4 keys, $5 their roots) that the org links, as foldClusters averaged them:
// each table's line is their mean, in whole points shared out by largest
// remainder so the lines add up to Math.round of the mean total, the points
// the row stored. An unfolded row is its own project's lines.
const ORG_LINES = `
	WITH comp AS (SELECT * FROM unnest($4::text[], $5::text[]) AS c(key, root)),
	members AS (
		SELECT i."organizationKey", i."projectKey", m.key AS member
		FROM "OrgScoreInputTable" i
		JOIN comp k ON k.key = i."projectKey"
		JOIN comp m ON m.root = k.root
		WHERE i."scoreProject" IS NOT NULL
		  AND EXISTS (SELECT 1 FROM "ProjectTable" p WHERE p."projectKey" = m.key AND p."deletedAt" IS NULL AND p."scoreProject" IS NOT NULL)
		  -- Linked by the subtree: every subtree org that links a project is in some input row's via.
		  AND EXISTS (
			SELECT 1 FROM "StakeholderTable" st
			JOIN "OrgScoreInputTable" j ON j."organizationKey" = i."organizationKey" AND st."organizationKey" = ANY(j."viaOrganizationKeys")
			WHERE st."projectKey" = m.key AND st."deletedAt" IS NULL
		  )
		UNION ALL
		SELECT i."organizationKey", i."projectKey", i."projectKey"
		FROM "OrgScoreInputTable" i
		WHERE i."scoreProject" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comp k WHERE k.key = i."projectKey")
	),
	sizes AS (SELECT "organizationKey", "projectKey", COUNT(*)::int AS n FROM members GROUP BY 1, 2),
	sums AS (
		SELECT m."organizationKey", m."projectKey", b."recordTable", SUM(b."pointsAwarded")::int AS s, SUM(b."pointsAvailable")::int AS v
		FROM members m
		JOIN "ProjectScoreByFieldTable" b ON b."projectKey" = m.member
		GROUP BY 1, 2, 3
	),
	shares AS (
		SELECT u."organizationKey", u."recordTable",
			u.s / z.n AS s_base, u.v / z.n AS v_base,
			(2 * SUM(u.s) OVER w + z.n) / (2 * z.n) - SUM(u.s / z.n) OVER w AS s_left,
			(2 * SUM(u.v) OVER w + z.n) / (2 * z.n) - SUM(u.v / z.n) OVER w AS v_left,
			ROW_NUMBER() OVER (PARTITION BY u."organizationKey", u."projectKey" ORDER BY u.s % z.n DESC, u."recordTable") AS s_order,
			ROW_NUMBER() OVER (PARTITION BY u."organizationKey", u."projectKey" ORDER BY u.v % z.n DESC, u."recordTable") AS v_order
		FROM sums u
		JOIN sizes z USING ("organizationKey", "projectKey")
		WINDOW w AS (PARTITION BY u."organizationKey", u."projectKey")
	)
	SELECT "organizationKey" AS key, "recordTable",
		SUM(s_base + (s_order <= s_left)::int)::int AS awarded,
		SUM(v_base + (v_order <= v_left)::int)::int AS available
	FROM shares
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
 * the points-weighted mean of the scored projects it averaged; a folded
 * cluster's lines are its members' mean, as the cluster was scored. Unscored rows
 * reconcile: they show no breakdown. A project's percentile is the PERCENT_RANK
 * rank_projects stored; its rank, 1 = best, is counted here. An org's
 * percentile and rank are rankOrgs', within the group frozen beside them as
 * `category`: its category, or `all` when that group was under the minimum and
 * it ranked among every ranked org. Returns the keys that did
 * not reconcile.
 */
export async function snapshotRun(db: SnapshotDb, scoreRunId: string): Promise<string[]> {
	const pairs = await foldPairs(db);
	const components = clustersOf(pairs.flatMap((p) => [p.keyA, p.keyB]), pairs);
	const compKeys = components.flat();
	const compRoots = components.flatMap((c) => c.map(() => c[0]));
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
			SELECT $1, 'org', o."organizationKey", o."scoreOrgFinal", o."scorePercentile", o."scoreRank", o."scoreCohort",
				CASE WHEN g.n < $2::int THEN $3::text ELSE o."primaryStakeholderCategory" END, o."scoreRatioDisclosure",
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
			-- The group rankOrgs ranked it within: its category, or every ranked org when that group is small.
			LEFT JOIN (
				SELECT "organizationKey", COUNT(*) OVER (PARTITION BY COALESCE("primaryStakeholderCategory", '')) AS n
				FROM "OrganizationTable" WHERE "deletedAt" IS NULL AND "scoreRank" IS NOT NULL
			) g ON g."organizationKey" = o."organizationKey"
			WHERE o."deletedAt" IS NULL`,
			scoreRunId,
			MIN_CATEGORY_GROUP,
			ALL_GROUP,
			compKeys,
			compRoots,
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
