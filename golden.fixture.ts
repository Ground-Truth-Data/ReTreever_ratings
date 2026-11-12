import type { Prisma, PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { rankOrgs, scoreOneOrg } from "./orgScore.js";
import { fieldPoints, scoreOneProject } from "./projectScore.js";
import config from "./scoreConfig.json" with { type: "json" };

/** Six orgs, one per dispute the method must settle the same way every run. */
export const GOLDEN_ORGS = ["noClaim", "validated", "overClaim", "unvalidated", "restated", "nothing"] as const;
export type GoldenOrg = (typeof GOLDEN_ORGS)[number];

export const GOLDEN_SERVED: Prisma.OrganizationTableWhereInput = { isParent: true, deletedAt: null };

const SQUARE = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };

type Site = { latLon: boolean; polygon: object; planted: number; crop: boolean };

const SITES: Record<Exclude<GoldenOrg, "nothing">, Site> = {
	noClaim: { latLon: true, polygon: SQUARE, planted: 500, crop: true },
	validated: { latLon: false, polygon: SQUARE, planted: 800, crop: true },
	overClaim: { latLon: true, polygon: {}, planted: 500, crop: true },
	unvalidated: { latLon: true, polygon: SQUARE, planted: 500, crop: true },
	restated: { latLon: true, polygon: SQUARE, planted: 500, crop: false },
};

type Claim = { key: string; qty: number | null; validated: boolean; claimDt?: string; supersedes?: string; category?: string };

const CLAIMS: Partial<Record<GoldenOrg, Claim[]>> = {
	validated: [{ key: "validated-1", qty: 1000, validated: true }],
	overClaim: [{ key: "overClaim-1", qty: 100, validated: true }],
	unvalidated: [{ key: "unvalidated-1", qty: 2000, validated: false }],
	restated: [
		{ key: "restated-1", qty: 2000, validated: true, claimDt: "2025-01-01" },
		{ key: "restated-2", qty: 1000, validated: true, claimDt: "2026-01-01", supersedes: "restated-1" },
		// Unvalidated: neither counts nor retires restated-2.
		{ key: "restated-3", qty: 9000, validated: false, claimDt: "2026-06-01", supersedes: "restated-2" },
		// No claimDt, an older createdAt: the dated claim in its category is the later one.
		{ key: "restated-4", qty: 50, validated: true, category: "seedlings" },
		{ key: "restated-5", qty: 250, validated: true, claimDt: "2026-02-01", category: "seedlings" },
	],
};

/** Seeds the six orgs, a parent each over its own project and records. */
export async function seedGolden(db: PrismaClient): Promise<void> {
	for (const org of GOLDEN_ORGS) {
		const organizationKey = `g-${org}`;
		await db.organizationTable.create({ data: { organizationKey, organizationName: org, isParent: true } });
		const site = org === "nothing" ? null : SITES[org];
		if (site) {
			const projectKey = `p-${org}`;
			await db.projectTable.create({ data: { projectKey, projectName: `${org} mangroves` } });
			await db.stakeholderTable.create({
				data: { stakeholderKey: `s-${org}`, organizationKey, projectKey, parentKey: projectKey, parentTable: "projectTable", stakeholderCategory: "developer" },
			});
			const landKey = `l-${org}`;
			await db.landTable.create({
				data: { landKey, landName: "Plot 1", projectKey, hectares: 1, ...(site.latLon ? { latitude: -3.1, longitude: 39.6 } : {}) },
			});
			await db.polygonTable.create({ data: { polygonKey: `g-${org}`, landKey, geometry: site.polygon } });
			await db.plantingTable.create({ data: { plantingKey: `t-${org}`, projectKey, parentKey: landKey, parentTable: "landTable", plantedQty: site.planted } });
			if (site.crop) await db.cropTable.create({ data: { cropKey: `c-${org}`, cropName: "Rhizophora mucronata", projectKey } });
		}
		for (const [i, c] of (CLAIMS[org] ?? []).entries()) {
			const sourceKey = `src-${c.key}`;
			await db.sourceTable.create({ data: { sourceKey, url: `https://example.org/${c.key}`, organizationKey, isValidated: c.validated } });
			await db.claimTable.create({
				data: {
					claimKey: c.key,
					claimQty: c.qty,
					sourceKey,
					organizationKey,
					claimCategory: c.category ?? "trees",
					createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
					...(c.claimDt ? { claimDt: new Date(c.claimDt) } : {}),
					...(c.supersedes ? { supersedesClaimKey: c.supersedes } : {}),
				},
			});
		}
	}
}

export type GoldenOutcome = {
	final: number | null;
	ratio: number | null;
	cohort: string | null;
	percentile: number | null;
	rank: number | null;
	claimKeys: string[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1e6) / 1e6);

/** Scores the seeded projects and orgs under `matrix`, ranks the served
 * population, and reads every outcome back. */
export async function runGolden(
	db: PrismaClient,
	matrix: Map<string, number>,
	scoreRunId = "golden",
): Promise<Record<GoldenOrg, GoldenOutcome>> {
	const points = fieldPoints(matrix, config.defaults.fieldPoints);
	await db.scoreRunTable.create({
		data: { scoreRunId, ratingsSha: "golden", dirty: false, matrixHash: "golden", configHash: "golden", methodologyVersion: "golden" },
	});
	for (const { projectKey } of await db.projectTable.findMany({ select: { projectKey: true }, orderBy: { projectKey: "asc" } }))
		await scoreOneProject(db, projectKey, points, scoreRunId);
	for (const org of GOLDEN_ORGS) await scoreOneOrg(db, `g-${org}`, scoreRunId);
	await rankOrgs(db, GOLDEN_SERVED);

	const rows = await db.organizationTable.findMany({
		where: { organizationKey: { in: GOLDEN_ORGS.map((o) => `g-${o}`) } },
		select: { organizationKey: true, scoreOrgFinal: true, scoreRatioDisclosure: true, scoreCohort: true, scorePercentile: true, scoreRank: true },
	});
	const claims = await db.scoreClaimInputTable.findMany({ where: { scoreRunId }, orderBy: { claimKey: "asc" } });
	return Object.fromEntries(
		rows.map((r) => [
			r.organizationKey.slice(2),
			{
				final: num(r.scoreOrgFinal),
				ratio: num(r.scoreRatioDisclosure),
				cohort: r.scoreCohort,
				percentile: num(r.scorePercentile),
				rank: r.scoreRank,
				claimKeys: claims.filter((c) => c.organizationKey === r.organizationKey).map((c) => c.claimKey),
			},
		]),
	) as Record<GoldenOrg, GoldenOutcome>;
}
