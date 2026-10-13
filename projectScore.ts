import crypto from "node:crypto";
import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";

export type ScoreDb = Pick<
	PrismaClient,
	| "projectTable"
	| "landTable"
	| "cropTable"
	| "plantingTable"
	| "miscTable"
	| "stakeholderTable"
	| "organizationTable"
	| "surveyTable"
	| "projectScoreByFieldTable"
>;

/** Points a field is worth; 0 means it is not scored at all. */
export type FieldPoints = (fieldName: string) => number;

/** Keys, stamps, authorship, pipeline bookkeeping, the row's own `score*`
 * columns and its serving flags: not transparency signals. A score column
 * counted as a field makes a rescore depend on whether the row was scored
 * before. */
export function isSystemField(fieldName: string): boolean {
	return (
		fieldName.endsWith("Key") ||
		fieldName.endsWith("At") ||
		fieldName.endsWith("By") ||
		fieldName.startsWith("score") ||
		fieldName === "isPublic" ||
		fieldName === "isParent" ||
		fieldName === "platformId" ||
		fieldName === "randomJson" ||
		fieldName === "errored" ||
		fieldName === "created" ||
		fieldName === "updated" ||
		fieldName === "duplicated" ||
		fieldName === "errorMessage" ||
		fieldName === "parentTable" ||
		fieldName === "parentKey"
	);
}

/** The matrix's weight, `defaultPoints` for any other field, 0 for a system field. */
export function fieldPoints(
	matrix: Map<string, number>,
	defaultPoints: number,
): FieldPoints {
	return (fieldName) =>
		isSystemField(fieldName) ? 0 : (matrix.get(fieldName) ?? defaultPoints);
}

export type FieldScore = {
	granularProjectScoreId: string;
	projectKey: string;
	pointsAwarded: number;
	fieldName: string;
	isAwarded: boolean;
	pointsAvailable: number;
};

export type Records = Record<string, object[]>;

/** Tier 1 over every record of every table: one row per scoreable field per
 * record, named `Table.field`. Populated means not null and not "". Pure. */
export function fieldScores(
	projectKey: string,
	tables: Records,
	points: FieldPoints,
): FieldScore[] {
	const out: FieldScore[] = [];
	for (const [tableName, records] of Object.entries(tables)) {
		for (const record of records) {
			for (const [fieldName, value] of Object.entries(record)) {
				const pointsAvailable = points(fieldName);
				if (pointsAvailable === 0) continue;
				const isAwarded = value !== null && value !== undefined && value !== "";
				out.push({
					granularProjectScoreId: crypto.randomUUID(),
					projectKey,
					pointsAwarded: isAwarded ? pointsAvailable : 0,
					fieldName: `${tableName}.${fieldName}`,
					isAwarded,
					pointsAvailable,
				});
			}
		}
	}
	return out;
}

/**
 * The live records of `keys`, by table, scalar columns only — a lone
 * listing's own, a parent's across its subtree. A soft-deleted record, or a
 * polygon under a live land, is not a record. SourceTable is not read:
 * ProjectTable's relation to it is an empty many-to-many, so the scorer has
 * never seen a source, and the ~40 columns of every source row would outweigh
 * every other table. Whether they count is a weights decision, not this walk's.
 */
export async function recordsOf(db: ScoreDb, keys: string[]): Promise<Records> {
	const of = { projectKey: { in: keys }, deletedAt: null };
	const [lands, crops, plantings, misc, stakeholders, surveys] =
		await Promise.all([
			db.landTable.findMany({
				where: of,
				include: { PolygonTable: { where: { deletedAt: null } } },
			}),
			db.cropTable.findMany({ where: of }),
			db.plantingTable.findMany({ where: of }),
			db.miscTable.findMany({ where: of }),
			db.stakeholderTable.findMany({ where: of }),
			db.surveyTable.findMany({ where: of }),
		]);
	return {
		LandTable: lands.map(({ PolygonTable: _, ...land }) => land),
		PolygonTable: lands.flatMap((l) => l.PolygonTable),
		CropTable: crops,
		PlantingTable: plantings,
		MiscTable: misc,
		StakeholderTable: stakeholders,
		SurveyTable: surveys,
	};
}

/**
 * Tier 2 for one project: its own row plus its own records, one by-field row
 * per field per record. A project is 1:1 with the platform's record, so there
 * is nothing above or below it to score over.
 */
export async function scoreOneProject(
	db: ScoreDb,
	projectKey: string,
	points: FieldPoints,
): Promise<void> {
	const project = await db.projectTable.findUnique({ where: { projectKey } });
	if (!project) return;

	const scores = fieldScores(
		projectKey,
		{ ProjectTable: [project], ...(await recordsOf(db, [projectKey])) },
		points,
	);

	await db.projectScoreByFieldTable.deleteMany({ where: { projectKey } });
	if (scores.length > 0) {
		await db.projectScoreByFieldTable.createMany({ data: scores });
	}

	const scorePointsAvailable = scores.reduce((sum, s) => sum + s.pointsAvailable, 0);
	const scorePointsScored = scores.reduce((sum, s) => sum + s.pointsAwarded, 0);
	// An org scores the mean of its projects, so every org on this one is stale
	// now. Before the project's flag clears: a failure between leaves the
	// project dirty to retry, never an org unmarked. Skipping rows already
	// flagged keeps a --full run from rewriting a busy org once per project.
	await db.organizationTable.updateMany({
		where: {
			deletedAt: null,
			OR: [{ scoreOrgFlag: false }, { scoreOrgFlag: null }],
			stakeholderTables: { some: { projectKey, deletedAt: null } },
		},
		data: { scoreOrgFlag: true },
	});
	await db.projectTable.update({
		where: { projectKey },
		data: {
			scoreProject:
				scorePointsAvailable > 0 ? scorePointsScored / scorePointsAvailable : 0,
			scorePointsAvailable,
			scorePointsScored,
			scoreLastUpdatedAt: new Date(),
			scoreProjectFlag: false,
		},
	});
}
