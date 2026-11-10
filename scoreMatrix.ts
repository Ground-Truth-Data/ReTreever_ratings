/**
 * The live weights. ScoreMatrixTable is a mirror of this file, rewritten from
 * it at the start of every score run; retuning a weight is a commit here.
 * Fields not listed default to 1 point (scoreConfig.json).
 */

import crypto from "node:crypto";

export const SCORE_MATRIX: Record<
	string,
	{ points: number; description: string }
> = {
	// Proves the site physically exists.
	geometry: { points: 20, description: "GeoJSON polygon data" },

	latitude: { points: 5, description: "GPS coordinate" },
	longitude: { points: 5, description: "GPS coordinate" },
	cropName: { points: 5, description: "Species identification" },
	speciesId: { points: 5, description: "Species identification" },
	plantingDt: { points: 5, description: "Temporal data" },
	plotCenter: { points: 5, description: "Circular plot geometry" },
	radius: { points: 5, description: "Circular plot geometry" },

	plantedQty: { points: 3, description: "Quantified impact" },

	stakeholderCategory: { points: 2, description: "Stakeholder classification" },
	pricePerUnit: { points: 2, description: "Economic data" },
	pricePerUnitUSD: { points: 2, description: "Economic data" },
};

/** Bumped when the method itself changes meaning — what counts as a field,
 * a tier, a baseline — not when a weight moves; a weight change is in
 * `matrixHash`. */
export const METHODOLOGY_VERSION = "1";

/** The weights as the scorer applies them: field → points. */
export function matrixPoints(): Map<string, number> {
	return new Map(Object.entries(SCORE_MATRIX).map(([f, { points }]) => [f, points]));
}

/** sha256 of the weights as applied — field names and points, sorted — so
 * two runs with the same hash scored with the same weights whatever else in
 * this file moved. */
export function matrixHash(): string {
	const weights = [...matrixPoints()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return crypto.createHash("sha256").update(JSON.stringify(weights)).digest("hex");
}

export type ScoreMatrixDb = {
	scoreMatrixTable: {
		findMany(args: { select: { fieldName: true; pointsAvailable: true; description: true } }): Promise<
			{ fieldName: string; pointsAvailable: number; description: string | null }[]
		>;
		upsert(args: {
			where: { fieldName: string };
			create: { fieldName: string; pointsAvailable: number; description: string };
			update: { pointsAvailable: number; description: string };
		}): Promise<unknown>;
		deleteMany(args: { where: { fieldName: { notIn: string[] } } }): Promise<{ count: number }>;
	};
};

/**
 * Makes ScoreMatrixTable equal this file: a row per weight, none else. Only a
 * row that differs is written, so `lastEditedAt` says when git's value last
 * reached the table rather than when it was last scored. Returns how many
 * rows changed.
 */
export async function seedScoreMatrix(db: ScoreMatrixDb): Promise<number> {
	const live = new Map(
		(await db.scoreMatrixTable.findMany({ select: { fieldName: true, pointsAvailable: true, description: true } })).map(
			(r) => [r.fieldName, r],
		),
	);
	let changed = 0;
	for (const [fieldName, { points, description }] of Object.entries(SCORE_MATRIX)) {
		const row = live.get(fieldName);
		if (row && row.pointsAvailable === points && row.description === description) continue;
		await db.scoreMatrixTable.upsert({
			where: { fieldName },
			create: { fieldName, pointsAvailable: points, description },
			update: { pointsAvailable: points, description },
		});
		changed++;
	}
	const { count } = await db.scoreMatrixTable.deleteMany({
		where: { fieldName: { notIn: Object.keys(SCORE_MATRIX) } },
	});
	return changed + count;
}
