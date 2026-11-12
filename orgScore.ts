import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { clustersOf, type FoldPair, foldPairs } from "./projectClusters.js";
import { MAX_DEPTH, orgSubtree } from "./subtree.js";

export type OrgScoreDb = Pick<
	PrismaClient,
	| "organizationTable"
	| "claimTable"
	| "orgScoreInputTable"
	| "$queryRaw"
	| "$executeRaw"
	| "$executeRawUnsafe"
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
	scoreRankOverall: null,
	scoreRankByCategory: null,
	primaryStakeholderCategory: null,
};

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

/** A live project in an org's subtree, as the org score reads it. */
export type LinkedProject = {
	projectKey: string;
	scoreProject: number | null;
	scorePointsAvailable: number | null;
	scorePointsScored: number | null;
	via: string[];
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
				planted: Math.max(...members.map((m) => m.planted)),
			},
		];
	});
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
	// it and its live plantings.
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
                (
                    SELECT COALESCE(SUM(p."plantedQty"), 0)::int
                    FROM "PlantingTable" p
                    WHERE p."projectKey" = pt."projectKey" AND p."deletedAt" IS NULL
                ) AS planted
            FROM "ProjectTable" pt
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

	const scoreOrgPreClaim =
		scored.length > 0
			? scored.reduce((sum, p) => sum + Number(p.scoreProject), 0) /
				scored.length
			: 0;
	const scorePointsAvailable = scored.reduce(
		(sum, p) => sum + Number(p.scorePointsAvailable || 0),
		0,
	);
	const scorePointsScored = scored.reduce(
		(sum, p) => sum + Number(p.scorePointsScored || 0),
		0,
	);

	// Tier 5: the subtree's claims against the plantings of the union of its projects.
	const claims = await db.claimTable.aggregate({
		where: { organizationKey: { in: localOrgIds }, deletedAt: null },
		_sum: { claimQty: true },
	});
	const scoreSumClaimed = claims._sum.claimQty ?? 0;

	const scoreSumPlantedQty = projects.reduce((sum, p) => sum + p.planted, 0);

	const scoreSumUndisclosed = scoreSumClaimed - scoreSumPlantedQty;
	const ratioDisclosure =
		scoreSumClaimed > 0 ? scoreSumPlantedQty / scoreSumClaimed : 1.0;
	const scoreOrgFinal = scoreOrgPreClaim * ratioDisclosure;

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

	// What was averaged, replaced whole and stamped with the org's own time,
	// before the flag clears: a failure between leaves the org dirty to retry.
	const scoredAt = new Date();
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
			primaryStakeholderCategory: mode?.stakeholderCategory,
			scoreLastUpdatedAt: scoredAt,
			scoreOrgFlag: false,
		},
	});
}

/**
 * Re-rank every live scored org by percentile, overall and partitioned by
 * stakeholder category. One-shot global SQL, ~1s. A soft-deleted org is in
 * neither distribution and keeps whatever rank it last had.
 */
export async function rankOrgs(db: OrgScoreDb): Promise<void> {
	console.log("\n📊 Ranking organizations...");

	await db.$executeRawUnsafe(`
        UPDATE "OrganizationTable" ot
        SET "scoreRankOverall" = ranked."scoreRankOverall"
        FROM (
            SELECT
                "organizationKey",
                ROUND(PERCENT_RANK() OVER (ORDER BY "scoreOrgFinal") * 100)::int AS "scoreRankOverall"
            FROM "OrganizationTable"
            WHERE "scoreOrgFinal" IS NOT NULL
              AND "deletedAt" IS NULL
        ) ranked
        WHERE ot."organizationKey" = ranked."organizationKey"
    `);

	await db.$executeRawUnsafe(`
        UPDATE "OrganizationTable" ot
        SET "scoreRankByCategory" = ranked."scoreRankByCategory"
        FROM (
            SELECT
                "organizationKey",
                ROUND(PERCENT_RANK() OVER (
                    PARTITION BY "primaryStakeholderCategory"
                    ORDER BY "scoreOrgFinal"
                ) * 100)::int AS "scoreRankByCategory"
            FROM "OrganizationTable"
            WHERE "primaryStakeholderCategory" IS NOT NULL
              AND "scoreOrgFinal" IS NOT NULL
              AND "deletedAt" IS NULL
        ) ranked
        WHERE ot."organizationKey" = ranked."organizationKey"
    `);

	console.log("✅ Organizations ranked");
}
