import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { MAX_DEPTH, orgSubtree } from "./subtree.js";

export type OrgScoreDb = Pick<
	PrismaClient,
	"organizationTable" | "claimTable" | "$queryRaw" | "$executeRaw" | "$executeRawUnsafe"
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

export async function scoreOneOrg(db: OrgScoreDb, organizationKey: string): Promise<void> {
	const org = await db.organizationTable.findUnique({
		where: { organizationKey },
		select: { organizationParentKey: true },
	});
	if (!org) return;

	if (org.organizationParentKey) {
		await db.organizationTable.update({
			where: { organizationKey },
			data: { ...NO_SCORE, scoreLastUpdatedAt: new Date(), scoreOrgFlag: false },
		});
		return;
	}

	// A parent scores over its subtree; a lone listing's subtree is itself.
	const localOrgIds = await orgSubtree(db, organizationKey);

	// Tier 4: every live project any org in the subtree is a stakeholder in,
	// once each however many rows point at it.
	const projects = await db.$queryRaw<
		Array<{
			projectKey: string;
			scoreProject: number | null;
			scorePointsAvailable: number | null;
			scorePointsScored: number | null;
		}>
	>`
            SELECT pt."projectKey", pt."scoreProject", pt."scorePointsAvailable", pt."scorePointsScored"
            FROM "ProjectTable" pt
            WHERE pt."deletedAt" IS NULL
              AND pt."projectKey" IN (
                SELECT st."projectKey"
                FROM "StakeholderTable" st
                WHERE st."organizationKey" = ANY(${localOrgIds}::text[])
                  AND st."deletedAt" IS NULL
              )
        `;
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

	const projectKeys = projects.map((p) => p.projectKey);
	const [{ planted }] = await db.$queryRaw<Array<{ planted: number }>>`
            SELECT COALESCE(SUM(p."plantedQty"), 0)::int AS planted
            FROM "PlantingTable" p
            WHERE p."projectKey" = ANY(${projectKeys}::text[])
              AND p."deletedAt" IS NULL
        `;
	const scoreSumPlantedQty = planted;

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
			scoreLastUpdatedAt: new Date(),
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
