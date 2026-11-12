import type { Prisma, PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { clustersOf, type FoldPair, foldPairs } from "./projectClusters.js";
import config from "./scoreConfig.json" with { type: "json" };
import { MAX_DEPTH, orgSubtree } from "./subtree.js";

export type OrgScoreDb = Pick<
	PrismaClient,
	| "organizationTable"
	| "orgScoreInputTable"
	| "scoreClaimInputTable"
	| "$queryRaw"
	| "$executeRaw"
>;

/** What a child with a parent carries: nothing. Its stakeholder rows and
 * claims are counted in its parent's score, so a score of its own would rank
 * one organization twice — and /who never serves it. */
export const NO_SCORE = {
	scoreOrgPreClaim: null,
	scorePointsAvailable: null,
	scorePointsScored: null,
	scoreSumClaimed: null,
	scoreSumPlantedQty: null,
	scoreSumUndisclosed: null,
	scoreOrgFinal: null,
	scoreRatioDisclosure: null,
	scoreCohort: null,
	scorePercentile: null,
	scoreRank: null,
	primaryStakeholderCategory: null,
};

/** An org with a current validated claim is ranked among its kind; one
 * without is ranked among orgs whose claims are not yet reviewed. */
export type Cohort = "reviewed" | "unreviewed";

/** The rows a run scores: live ones — dirty unless `full`, only `orgIds`
 * when given. A soft-deleted org is never rescored, whatever its flag says. */
export function orgWhere(full: boolean, orgIds?: string[]) {
	return {
		deletedAt: null,
		...(full ? {} : { scoreOrgFlag: true }),
		...(orgIds ? { organizationKey: { in: orgIds } } : {}),
	};
}

/** A dirty child dirties its parent, one UPDATE per level until a pass marks
 * nobody, so the parent — where the child's numbers are scored — is picked
 * up by the same run. Only between live rows: a soft-deleted child is never
 * scored, so its flag never clears and would re-dirty the parent every run.
 * Returns how many parents were marked. */
export async function propagateDirtyToParents(db: OrgScoreDb): Promise<number> {
	let marked = 0;
	for (let level = 0; level < MAX_DEPTH; level++) {
		const n = await db.$executeRaw`
            UPDATE "OrganizationTable" p
            SET "scoreOrgFlag" = true
            FROM "OrganizationTable" c
            WHERE c."organizationParentKey" = p."organizationKey"
              AND c."scoreOrgFlag" = true
              AND c."deletedAt" IS NULL
              AND p."deletedAt" IS NULL
              AND p."scoreOrgFlag" IS DISTINCT FROM true
        `;
		if (n === 0) break;
		marked += n;
	}
	return marked;
}

/** The stakeholder roles whose org owns a project's plantings (RT-0027). */
export const PLANTING_OWNER_ROLES: readonly string[] = config.plantingOwnerRoles;

/** A live project in an org's subtree, as the org score reads it. */
export type LinkedProject = {
	projectKey: string;
	scoreProject: number | null;
	scorePointsAvailable: number | null;
	scorePointsScored: number | null;
	via: string[];
	/** The subtree holds an owning role on it. */
	owns: boolean;
	/** Its live plantings, or 0 when the subtree does not own them. */
	planted: number;
};

/**
 * A cluster of folded listings as one unit, under its first key: the mean of
 * its scored members' score and points, the union of `via`, and the largest
 * member's planted (`sameAs` lists the same trees; a `partOf` whole holds its
 * sites'). Unfolded projects pass through untouched, in their order.
 */
export function foldClusters(projects: LinkedProject[], pairs: FoldPair[]): LinkedProject[] {
	const byKey = new Map(projects.map((p) => [p.projectKey, p]));
	const clusterOf = new Map(clustersOf([...byKey.keys()], pairs).flatMap((c) => c.map((k) => [k, c] as const)));
	return projects.flatMap((p) => {
		const keys = clusterOf.get(p.projectKey) ?? [p.projectKey];
		if (keys.length === 1) return [p];
		if (keys[0] !== p.projectKey) return [];
		const members = keys.map((k) => byKey.get(k) as LinkedProject);
		const scored = members.filter((m) => m.scoreProject !== null);
		// Number(): the driver hands `scoreProject` back as a Decimal.
		const mean = (f: (m: LinkedProject) => number | null) =>
			scored.length ? scored.reduce((s, m) => s + Number(f(m) ?? 0), 0) / scored.length : null;
		const points = (f: (m: LinkedProject) => number | null) => {
			const m = mean(f);
			return m === null ? null : Math.round(m);
		};
		return [
			{
				projectKey: p.projectKey,
				scoreProject: mean((m) => m.scoreProject),
				scorePointsAvailable: points((m) => m.scorePointsAvailable),
				scorePointsScored: points((m) => m.scorePointsScored),
				via: [...new Set(members.flatMap((m) => m.via))].sort(),
				owns: members.some((m) => m.owns),
				planted: Math.max(...members.map((m) => m.planted)),
			},
		];
	});
}

/**
 * The mean of the scored projects' scores weighted by their points
 * available, so a project with ninety fields outweighs one with nine. Null
 * when nothing is available to score.
 */
export function weightedMean(projects: Pick<LinkedProject, "scoreProject" | "scorePointsAvailable">[]): number | null {
	let weight = 0;
	let sum = 0;
	for (const p of projects) {
		if (p.scoreProject === null) continue;
		const w = Number(p.scorePointsAvailable ?? 0);
		if (!(w > 0)) continue;
		weight += w;
		sum += Number(p.scoreProject) * w;
	}
	return weight > 0 ? sum / weight : null;
}

/** A claim as the scorer counts it: current, its source validated. */
export type CurrentClaim = { claimKey: string; claimQty: number | null };

export type Disclosure = {
	cohort: Cohort;
	ratio: number | null;
	sumClaimed: number | null;
	claimKeys: string[];
};

/**
 * Planted over claimed, capped at 1, over the current claims that state a
 * tree count. With none, the org has no reviewed claim: no ratio, and its
 * own cohort. A count of 0 claims no trees, so everything planted is
 * disclosed. `planted` null is an org that owns no plantings: its claims
 * have nothing of its own to be measured against, so no ratio either.
 */
export function disclosure(planted: number | null, claims: CurrentClaim[]): Disclosure {
	const counted = claims.filter((c) => c.claimQty !== null);
	if (planted === null || counted.length === 0) return { cohort: "unreviewed", ratio: null, sumClaimed: null, claimKeys: [] };
	const sumClaimed = counted.reduce((s, c) => s + Number(c.claimQty), 0);
	return {
		cohort: "reviewed",
		ratio: sumClaimed > 0 ? Math.min(1, planted / sumClaimed) : 1,
		sumClaimed,
		claimKeys: counted.map((c) => c.claimKey).sort(),
	};
}

/**
 * The subtree's current claims, as the claims log writes them: live, not
 * named by any later row (an edit or an ending row alike), the latest per
 * org and category by `claimDt` (a claim with none dates from its
 * `createdAt`), and on a live source validated against its latest capture.
 * A current claim whose source is not validated counts for nothing: the org
 * is not handed the claim it replaced.
 */
export function currentClaims(db: Pick<PrismaClient, "$queryRaw">, orgKeys: string[]): Promise<CurrentClaim[]> {
	return db.$queryRaw<CurrentClaim[]>`
		WITH latest AS (
			SELECT c."claimKey", c."claimQty", c."sourceKey", ROW_NUMBER() OVER (
				PARTITION BY c."organizationKey", c."claimCategory"
				ORDER BY COALESCE(c."claimDt", c."createdAt") DESC NULLS LAST, c."claimKey" DESC
			) AS n
			FROM "ClaimTable" c
			WHERE c."organizationKey" = ANY(${orgKeys}::text[])
			  AND c."deletedAt" IS NULL
			  AND NOT EXISTS (SELECT 1 FROM "ClaimTable" r WHERE r."supersedesClaimKey" = c."claimKey")
		)
		SELECT l."claimKey", l."claimQty"
		FROM latest l
		JOIN "SourceTable" s ON s."sourceKey" = l."sourceKey"
		WHERE l.n = 1
		  AND s."deletedAt" IS NULL
		  AND s."isValidated" IS TRUE
		  AND s."validatedManifestSha" IS NOT DISTINCT FROM s."captureManifestSha"
		  AND s."validatedManifestSha" IS NOT NULL
		ORDER BY l."claimKey"
	`;
}

export async function scoreOneOrg(db: OrgScoreDb, organizationKey: string, scoreRunId: string): Promise<void> {
	const org = await db.organizationTable.findUnique({
		where: { organizationKey },
		select: { organizationParentKey: true },
	});
	if (!org) return;

	if (org.organizationParentKey) {
		await db.orgScoreInputTable.deleteMany({ where: { organizationKey } });
		await db.organizationTable.update({
			where: { organizationKey },
			data: { ...NO_SCORE, scoreLastUpdatedAt: new Date(), scoreOrgFlag: false },
		});
		return;
	}

	// A parent scores over its subtree; a lone listing's subtree is itself.
	const localOrgIds = await orgSubtree(db, organizationKey);

	// Tier 4: every live project any org in the subtree is a stakeholder in,
	// once each however many rows point at it, with the subtree orgs that link
	// it and its live plantings when the subtree holds an owning role on it.
	const linked = await db.$queryRaw<LinkedProject[]>`
            SELECT pt."projectKey", pt."scoreProject", pt."scorePointsAvailable", pt."scorePointsScored",
                ARRAY(
                    SELECT DISTINCT st."organizationKey"
                    FROM "StakeholderTable" st
                    WHERE st."projectKey" = pt."projectKey"
                      AND st."organizationKey" = ANY(${localOrgIds}::text[])
                      AND st."deletedAt" IS NULL
                    ORDER BY st."organizationKey"
                ) AS via,
                o.owns,
                CASE WHEN o.owns THEN (
                    SELECT COALESCE(SUM(p."plantedQty"), 0)::int
                    FROM "PlantingTable" p
                    WHERE p."projectKey" = pt."projectKey" AND p."deletedAt" IS NULL
                ) ELSE 0 END AS planted
            FROM "ProjectTable" pt
            CROSS JOIN LATERAL (
                SELECT EXISTS (
                    SELECT 1 FROM "StakeholderTable" st
                    WHERE st."projectKey" = pt."projectKey"
                      AND st."organizationKey" = ANY(${localOrgIds}::text[])
                      AND st."deletedAt" IS NULL
                      AND st."stakeholderCategory" = ANY(${PLANTING_OWNER_ROLES}::text[])
                ) AS owns
            ) o
            WHERE pt."deletedAt" IS NULL
              AND pt."projectKey" IN (
                SELECT st."projectKey"
                FROM "StakeholderTable" st
                WHERE st."organizationKey" = ANY(${localOrgIds}::text[])
                  AND st."deletedAt" IS NULL
              )
        `;
	// Listings a person called one planting, inside this family, count once.
	const projects = linked.length > 1 ? foldClusters(linked, await foldPairs(db)) : linked;
	const scored = projects.filter((p) => p.scoreProject !== null);

	const scoreOrgPreClaim = weightedMean(scored);
	const scorePointsAvailable = scored.reduce(
		(sum, p) => sum + Number(p.scorePointsAvailable || 0),
		0,
	);
	const scorePointsScored = scored.reduce(
		(sum, p) => sum + Number(p.scorePointsScored || 0),
		0,
	);

	// Tier 5: the subtree's current claims against the plantings it owns.
	// Nothing scored has no claim to weigh either.
	const scoreSumPlantedQty = projects.reduce((sum, p) => sum + p.planted, 0);
	const owned = projects.some((p) => p.owns) ? scoreSumPlantedQty : null;
	const told = scoreOrgPreClaim === null ? null : disclosure(owned, await currentClaims(db, localOrgIds));
	const scoreSumClaimed = told?.sumClaimed ?? null;
	const scoreSumUndisclosed = scoreSumClaimed === null ? null : scoreSumClaimed - scoreSumPlantedQty;
	const scoreOrgFinal = scoreOrgPreClaim === null ? null : scoreOrgPreClaim * (told?.ratio ?? 1);

	// Tier 8: the MODE across the subtree, alphabetical tiebreak. No categorised
	// row leaves the column alone — a p- parent keeps the category a human
	// chose at creation until a listing is linked under it.
	const [mode] = await db.$queryRaw<Array<{ stakeholderCategory: string }>>`
            SELECT st."stakeholderCategory"
            FROM "StakeholderTable" st
            WHERE st."organizationKey" = ANY(${localOrgIds}::text[])
              AND st."deletedAt" IS NULL
              AND st."stakeholderCategory" IS NOT NULL
            GROUP BY st."stakeholderCategory"
            ORDER BY COUNT(*) DESC, st."stakeholderCategory" ASC
            LIMIT 1
        `;

	// What was averaged and summed, replaced whole and stamped with the org's
	// own time, before the flag clears: a failure between leaves the org dirty to retry.
	const scoredAt = new Date();
	await db.scoreClaimInputTable.deleteMany({ where: { scoreRunId, organizationKey } });
	if (told?.claimKeys.length) {
		await db.scoreClaimInputTable.createMany({
			data: told.claimKeys.map((claimKey) => ({ scoreRunId, organizationKey, claimKey })),
		});
	}
	await db.orgScoreInputTable.deleteMany({ where: { organizationKey } });
	if (projects.length > 0) {
		await db.orgScoreInputTable.createMany({
			data: projects.map((p) => ({
				organizationKey,
				projectKey: p.projectKey,
				viaOrganizationKeys: p.via,
				scoreProject: p.scoreProject,
				scorePointsScored: p.scorePointsScored,
				scorePointsAvailable: p.scorePointsAvailable,
				plantedQty: p.planted,
				scoredAt,
				scoreRunId,
			})),
		});
	}

	await db.organizationTable.update({
		where: { organizationKey },
		data: {
			scoreOrgPreClaim,
			scorePointsAvailable,
			scorePointsScored,
			scoreSumClaimed,
			scoreSumPlantedQty,
			scoreSumUndisclosed,
			scoreOrgFinal,
			scoreRatioDisclosure: told?.ratio ?? null,
			scoreCohort: told?.cohort ?? null,
			primaryStakeholderCategory: mode?.stakeholderCategory,
			scoreLastUpdatedAt: scoredAt,
			scoreOrgFlag: false,
		},
	});
}

/**
 * The published rating: each served org with a final score gets the share
 * of its cohort scoring at or below it (CUME_DIST, so tied orgs share one
 * percentile and the top org is 1) and its competition rank, 1 the best.
 * Every other row, soft-deleted, unserved or null, holds neither. `served`
 * is the site's own predicate, passed in so it is never restated here.
 */
export async function rankOrgs(db: Pick<PrismaClient, "organizationTable" | "$executeRaw">, served: Prisma.OrganizationTableWhereInput): Promise<void> {
	console.log("\n📊 Ranking organizations...");
	const keys = (await db.organizationTable.findMany({ where: served, select: { organizationKey: true } })).map(
		(o) => o.organizationKey,
	);
	await db.$executeRaw`
		UPDATE "OrganizationTable" ot
		SET "scorePercentile" = ranked.p, "scoreRank" = ranked.k
		FROM (
			SELECT o."organizationKey", r.p, r.k
			FROM "OrganizationTable" o
			LEFT JOIN (
				SELECT "organizationKey",
					CUME_DIST() OVER (PARTITION BY "scoreCohort" ORDER BY "scoreOrgFinal") AS p,
					RANK() OVER (PARTITION BY "scoreCohort" ORDER BY "scoreOrgFinal" DESC)::int AS k
				FROM "OrganizationTable"
				WHERE "organizationKey" = ANY(${keys}::text[])
				  AND "deletedAt" IS NULL
				  AND "scoreOrgFinal" IS NOT NULL
				  AND "scoreCohort" IS NOT NULL
			) r ON r."organizationKey" = o."organizationKey"
		) ranked
		WHERE ot."organizationKey" = ranked."organizationKey"
		  AND (ot."scorePercentile" IS DISTINCT FROM ranked.p OR ot."scoreRank" IS DISTINCT FROM ranked.k)
	`;
	console.log(`✅ Ranked ${keys.length} served organizations`);
}
