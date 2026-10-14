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
	| "sourceTable"
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
		// Where the map read each value, not a value the platform disclosed.
		fieldName === "provenance" ||
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

const populated = (value: unknown) =>
	value !== null && value !== undefined && value !== "";

function fieldScore(
	projectKey: string,
	fieldName: string,
	value: unknown,
	pointsAvailable: number,
): FieldScore {
	const isAwarded = populated(value);
	return {
		granularProjectScoreId: crypto.randomUUID(),
		projectKey,
		pointsAwarded: isAwarded ? pointsAvailable : 0,
		fieldName,
		isAwarded,
		pointsAvailable,
	};
}

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
				out.push(fieldScore(projectKey, `${tableName}.${fieldName}`, value, pointsAvailable));
			}
		}
	}
	return out;
}

/** A table scored on a few baseline fields, where a further record can only
 * add. `key` breaks ties; `capBy` lets one record per distinct value count. */
export type Bonusable = {
	key: string;
	baseline: readonly string[];
	capBy?: string;
};

/** Each table listed here moves every project's rank when it joins: switch
 * one on with a full rescore, never in passing. */
export const BONUSABLE: Record<string, Bonusable> = {
	SourceTable: {
		key: "sourceKey",
		baseline: [
			"url",
			"urlType",
			"disclosureType",
			"sourceDesc",
			"sourceCredit",
			"stakeholderCategoryId",
		],
		// A gallery scrape is a hundred photos of one kind; counted each, volume
		// would buy the score.
		capBy: "urlType",
	},
};

/**
 * Tier 1 for a bonusable table. The baseline record counts every baseline
 * field, filled or not — with no record, every one is available and unscored.
 * Each further record adds only the baseline fields it fills, to awarded and
 * available alike. No other column of the table is ever a field. Pure.
 *
 * The baseline is the record that fills the most points: SourceTable has no
 * creation order, so "first" has to mean something, and the fullest record is
 * the one a project is fairly judged by.
 */
export function bonusableScores(
	projectKey: string,
	tableName: string,
	records: object[],
	rule: Bonusable,
	points: FieldPoints,
): FieldScore[] {
	const fields = rule.baseline.filter((f) => points(f) > 0);
	const ranked = (records as Record<string, unknown>[])
		.map((record) => ({
			record,
			filled: fields.reduce((sum, f) => sum + (populated(record[f]) ? points(f) : 0), 0),
			key: String(record[rule.key]),
		}))
		.sort((a, b) => b.filled - a.filled || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map(({ record }) => record);

	const seen = new Set<string>();
	const counted = rule.capBy
		? ranked.filter((record) => {
				const group = String(record[rule.capBy as string] ?? "");
				if (seen.has(group)) return false;
				seen.add(group);
				return true;
			})
		: ranked;

	const [baseline, ...bonus] = counted;
	const out = fields.map((f) =>
		fieldScore(projectKey, `${tableName}.${f}`, baseline?.[f], points(f)),
	);
	for (const record of bonus)
		for (const f of fields)
			if (populated(record[f]))
				out.push(fieldScore(projectKey, `${tableName}.${f}`, record[f], points(f)));
	return out;
}

/** Tier 1 for one project: a bonusable table by its rule, every other table
 * by every scoreable field of every record. Pure. */
export function projectFieldScores(
	projectKey: string,
	tables: Records,
	points: FieldPoints,
): FieldScore[] {
	return Object.entries(tables).flatMap(([tableName, records]) => {
		const rule = BONUSABLE[tableName];
		return rule
			? bonusableScores(projectKey, tableName, records, rule, points)
			: fieldScores(projectKey, { [tableName]: records }, points);
	});
}

/**
 * The live records of `keys`, by table, scalar columns only. A soft-deleted
 * record, or a soft-deleted polygon under a live land, is not a record.
 * Sources are read by `SourceTable.projectKey`: ProjectTable's many-to-many
 * relation to them is empty.
 */
export async function recordsOf(db: ScoreDb, keys: string[]): Promise<Records> {
	const of = { projectKey: { in: keys }, deletedAt: null };
	const [lands, crops, plantings, misc, stakeholders, surveys, sources] =
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
			db.sourceTable.findMany({ where: of }),
		]);
	return {
		LandTable: lands.map(({ PolygonTable: _, ...land }) => land),
		PolygonTable: lands.flatMap((l) => l.PolygonTable),
		CropTable: crops,
		PlantingTable: plantings,
		MiscTable: misc,
		StakeholderTable: stakeholders,
		SurveyTable: surveys,
		SourceTable: sources,
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

	const scores = projectFieldScores(
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
