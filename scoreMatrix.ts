/**
 * Bootstrap values only — ScoreMatrixTable in the DB holds the live weights;
 * edit them there. Fields not listed default to 1 point (scoreConfig.json).
 */

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

	// SourceTable baseline. url and urlType are on every scraped source, so they
	// stay at 1; who published a source and who made it are what set one
	// project's evidence apart from another's.
	disclosureType: { points: 5, description: "Who published the source" },
	sourceCredit: { points: 5, description: "Who made the source" },
	stakeholderCategoryId: { points: 2, description: "Stakeholder classification" },
};

/**
 * Populate ScoreMatrixTable only if empty — never updates or deletes, so the
 * DB always wins. Returns the rows created.
 */
export async function seedScoreMatrixIfEmpty(
	// biome-ignore lint/suspicious/noExplicitAny: PrismaClient type varies by import path
	prisma: any,
): Promise<number> {
	const existing = await prisma.scoreMatrixTable.count();
	if (existing > 0) return 0;

	console.log(
		"⚠️  ScoreMatrixTable is empty — bootstrapping from scoreMatrix.ts",
	);

	const rows = Object.entries(SCORE_MATRIX).map(
		([fieldName, { points, description }]) => ({
			fieldName,
			pointsAvailable: points,
			description,
		}),
	);

	await prisma.scoreMatrixTable.createMany({ data: rows });

	for (const row of rows) {
		console.log(`  ${row.fieldName}: ${row.pointsAvailable} pts`);
	}
	console.log(
		`✅ Seeded ${rows.length} field weights. The DB is now the source of truth —`,
	);
	console.log(
		"   edit ScoreMatrixTable directly to retune; this file won't overwrite it.",
	);

	return rows.length;
}
