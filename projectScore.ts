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
	| "$transaction"
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
		fieldName === "runId" ||
		fieldName === "linkStatus" ||
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
	recordTable: string;
	/** Null only on a bonusable table's baseline when the project has no record there. */
	recordKey: string | null;
	pointsAwarded: number;
	fieldName: string;
	isAwarded: boolean;
	pointsAvailable: number;
};

/** Each scored table's primary key: what a by-field row names its record by. */
export const RECORD_KEY: Record<string, string> = {
	ProjectTable: "projectKey",
	LandTable: "landKey",
	PolygonTable: "polygonKey",
	CropTable: "cropKey",
	PlantingTable: "plantingKey",
	MiscTable: "polyKey",
	StakeholderTable: "stakeholderKey",
	SurveyTable: "plotKey",
	SourceTable: "sourceKey",
};

function recordKeyOf(tableName: string, record: object): string {
	const column = RECORD_KEY[tableName];
	const key = column ? (record as Record<string, unknown>)[column] : undefined;
	if (typeof key !== "string" || key === "")
		throw new Error(`${tableName}: a scored record without its ${column ?? "primary key"}`);
	return key;
}

export type Records = Record<string, object[]>;

/** Words a platform fills a required box with when it has nothing to say.
 * Text with no letter or digit at all ("-", "...", "[]") is caught apart. */
export const PLACEHOLDER_TEXT: ReadonlySet<string> = new Set([
	"n/a", "na", "null", "none", "unknown", "undefined", "nan", "nil",
	"tbd", "tba", "not available", "not specified", "not provided",
]);

/** A coordinate of exactly 0 is Null Island: the default, not a place. */
const COORDINATE_FIELDS = new Set(["latitude", "longitude"]);
/** A size of 0 or less measures nothing. Not `hectaresCalc`: it is derived
 * from the geometry, rounded to 0.1, so a real sliver reads 0.0. */
const SIZE_FIELDS = new Set(["hectares", "radius"]);

type Ring = number[][];

/** Planar shoelace area in square degrees: only its sign of > 0 is read. */
function ringArea(ring: Ring): number {
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x1, y1] = ring[i].map(Number);
		const [x2, y2] = ring[(i + 1) % ring.length].map(Number);
		sum += x1 * y2 - x2 * y1;
	}
	return Number.isFinite(sum) ? Math.abs(sum) / 2 : 0;
}

const outerRings = (g: Record<string, unknown>): Ring[] => {
	const coords = g.coordinates;
	if (!Array.isArray(coords)) return [];
	if (g.type === "Polygon") return coords.slice(0, 1) as Ring[];
	if (g.type === "MultiPolygon") return (coords as Ring[][]).map((p) => p?.[0]).filter(Array.isArray);
	return [];
};

/** A Polygon or MultiPolygon (bare, or in a Feature, FeatureCollection or
 * GeometryCollection) whose outer ring encloses area: anything else, `{}`
 * and a point included, proves no site. */
export function isRealPolygon(value: unknown): boolean {
	let g = value;
	if (typeof g === "string") {
		try {
			g = JSON.parse(g);
		} catch {
			return false;
		}
	}
	if (!g || typeof g !== "object") return false;
	const o = g as Record<string, unknown>;
	if (o.type === "Feature") return isRealPolygon(o.geometry);
	if (o.type === "FeatureCollection") return Array.isArray(o.features) && o.features.some(isRealPolygon);
	if (o.type === "GeometryCollection") return Array.isArray(o.geometries) && o.geometries.some(isRealPolygon);
	return outerRings(o).some((r) => Array.isArray(r) && r.length >= 3 && ringArea(r) > 0);
}

const asNumber = (value: unknown): number | null =>
	typeof value === "number"
		? value
		: value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function"
			? Number(value.toNumber())
			: null;

/**
 * Whether a field holds a value, by its type: null, blank or placeholder
 * text (measured on dev 12 Nov: "[]", "...", "-", "n/a"), an empty object or list, an invalid date, a non-finite number, a
 * coordinate of 0 or a size of 0 or less is not one, and `geometry` is one
 * only as a real polygon. Booleans always are.
 */
export function populated(fieldName: string, value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (fieldName === "geometry") return isRealPolygon(value);
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		return /[\p{L}\p{N}]/u.test(text) && !PLACEHOLDER_TEXT.has(text);
	}
	if (value instanceof Date) return !Number.isNaN(value.getTime());
	const n = asNumber(value);
	if (n !== null) {
		if (!Number.isFinite(n)) return false;
		if (COORDINATE_FIELDS.has(fieldName)) return n !== 0;
		if (SIZE_FIELDS.has(fieldName)) return n > 0;
		return true;
	}
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

function fieldScore(
	projectKey: string,
	recordTable: string,
	recordKey: string | null,
	field: string,
	value: unknown,
	pointsAvailable: number,
): FieldScore {
	const isAwarded = populated(field, value);
	const fieldName = `${recordTable}.${field}`;
	return {
		granularProjectScoreId: crypto.randomUUID(),
		projectKey,
		recordTable,
		recordKey,
		pointsAwarded: isAwarded ? pointsAvailable : 0,
		fieldName,
		isAwarded,
		pointsAvailable,
	};
}

/** Tier 1 over every record of every table: one row per scoreable field per
 * record, named `Table.field` and naming its record; awarded when `populated`. Pure. */
export function fieldScores(
	projectKey: string,
	tables: Records,
	points: FieldPoints,
): FieldScore[] {
	const out: FieldScore[] = [];
	for (const [tableName, records] of Object.entries(tables)) {
		for (const record of records) {
			const recordKey = recordKeyOf(tableName, record);
			for (const [fieldName, value] of Object.entries(record)) {
				const pointsAvailable = points(fieldName);
				if (pointsAvailable === 0) continue;
				out.push(fieldScore(projectKey, tableName, recordKey, fieldName, value, pointsAvailable));
			}
		}
	}
	return out;
}

/** A table scored on a few baseline fields, where a further record can only
 * add. Its `RECORD_KEY` breaks ties; `capBy` lets one record per distinct value count. */
export type Bonusable = {
	baseline: readonly string[];
	capBy?: string;
};

/** Each table listed here moves every project's rank when it joins: switch
 * one on with a full rescore, never in passing. */
export const BONUSABLE: Record<string, Bonusable> = {
	SourceTable: {
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
 * field, filled or not — with no record, every one is available and unscored,
 * and its row names the table and no key. Each further record adds only the
 * baseline fields it fills, to awarded and available alike. No other column of
 * the table is ever a field. Pure.
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
			filled: fields.reduce((sum, f) => sum + (populated(f, record[f]) ? points(f) : 0), 0),
			key: recordKeyOf(tableName, record),
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
	const baselineKey = baseline ? recordKeyOf(tableName, baseline) : null;
	const out = fields.map((f) =>
		fieldScore(projectKey, tableName, baselineKey, f, baseline?.[f], points(f)),
	);
	for (const record of bonus) {
		const recordKey = recordKeyOf(tableName, record);
		for (const f of fields)
			if (populated(f, record[f]))
				out.push(fieldScore(projectKey, tableName, recordKey, f, record[f], points(f)));
	}
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
 * per field per record, each stamped with the run that wrote it. A project
 * is 1:1 with the platform's record, so there is nothing above or below it
 * to score over.
 */
export async function scoreOneProject(
	db: ScoreDb,
	projectKey: string,
	points: FieldPoints,
	scoreRunId: string,
): Promise<void> {
	const project = await db.projectTable.findUnique({ where: { projectKey } });
	if (!project) return;

	const scores = projectFieldScores(
		projectKey,
		{ ProjectTable: [project], ...(await recordsOf(db, [projectKey])) },
		points,
	);

	const scorePointsAvailable = scores.reduce((sum, s) => sum + s.pointsAvailable, 0);
	const scorePointsScored = scores.reduce((sum, s) => sum + s.pointsAwarded, 0);
	// One transaction: a deadlock on an org another worker shares must not leave
	// the field rows new and the project's own score old. The waits are for a
	// pool its workers' parallel reads keep busy, past Prisma's 2 s default.
	await db.$transaction(
		async (tx) => {
			await tx.projectScoreByFieldTable.deleteMany({ where: { projectKey } });
			if (scores.length > 0) {
				await tx.projectScoreByFieldTable.createMany({ data: scores.map((s) => ({ ...s, scoreRunId })) });
			}
			// An org scores the mean of its projects, so every org on this one is
			// stale now. Skipping rows already flagged keeps a --full run from
			// rewriting a busy org once per project.
			await tx.organizationTable.updateMany({
				where: {
					deletedAt: null,
					OR: [{ scoreOrgFlag: false }, { scoreOrgFlag: null }],
					stakeholderTables: { some: { projectKey, deletedAt: null } },
				},
				data: { scoreOrgFlag: true },
			});
			await tx.projectTable.update({
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
		},
		{ maxWait: 30_000, timeout: 30_000 },
	);
}
