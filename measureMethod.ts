/**
 * What the method in projectScore.ts would do to every live project, against
 * the score each one stores. Reads only: it calls no scorer that writes, and
 * every connection it opens refuses a write.
 *
 * A record's fields score as they did in the run that wrote the stored
 * by-field rows, so those rows are read, not re-derived: a dozen queries over
 * two connections instead of ten per project over the whole pool, which the
 * session pooler's fifteen clients cannot spare. What the method adds is
 * computed here by its own `fieldScores`: a table with no record, and each
 * project's organizations, claims and species. `--check n` scores n projects
 * from their records by `recordsOf` and refuses any that differs.
 *
 *   cd ReTreever && npx varlock run -- npx tsx ../ReTreever_ratings/measureMethod.ts <out.json> [--check n] [projectKey…]
 */
import { writeFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { currentClaims } from "./orgScore.js";
import { BONUSABLE, type FieldScore, fieldPoints, fieldScores, OFFERED, projectFieldScores, recordsOf } from "./projectScore.js";
import config from "./scoreConfig.json" with { type: "json" };
import { matrixPoints } from "./scoreMatrix.js";

type Tally = Record<string, { scored: number; available: number }>;
type Row = { key: string; name: string; platform: string | null; was: number | null; now: number; scored: number; available: number; tables: Tally };

const args = process.argv.slice(2);
const out = args.shift();
if (!out) throw new Error("usage: measureMethod.ts <out.json> [--check n] [projectKey…]");
const check = args[0] === "--check" ? Number(args.splice(0, 2)[1]) : 0;
const WATCH = new Set(args);

const connectionString = process.env.GC_RT_supabase_dev_session;
if (!connectionString) throw new Error("GC_RT_supabase_dev_session is not set!");
// A session SET on the transaction pooler outlives this process on a backend other clients are handed.
if (new URL(connectionString).port === "6543") throw new Error("measure over the session pooler, never the transaction pooler");

const pool = new pg.Pool({ connectionString, max: 2, ssl: { rejectUnauthorized: false }, keepAlive: true, query_timeout: 300_000 });
pool.on("connect", (client) => void client.query("SET default_transaction_read_only = on"));
const db = new PrismaClient({ adapter: new PrismaPg(pool) });
const points = fieldPoints(matrixPoints(), config.defaults.fieldPoints);

/** The tables the method reaches through a project's records; every other one's rows are stored already. */
const REACHED = ["SpeciesTable", "OrganizationTable", "ClaimTable"];
const STORED = Object.keys(OFFERED).filter((table) => !REACHED.includes(table)).concat(Object.keys(BONUSABLE));
const pick = (fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, true]));
const group = <T>(rows: T[], key: (row: T) => string | null) => {
	const by = new Map<string, T[]>();
	for (const row of rows) {
		const k = key(row);
		if (k !== null) by.set(k, [...(by.get(k) ?? []), row]);
	}
	return by;
};

const projects = await db.projectTable.findMany({
	where: { deletedAt: null },
	select: { projectKey: true, projectName: true, platformId: true, scoreProject: true, scorePointsScored: true, scorePointsAvailable: true },
	orderBy: { projectKey: "asc" },
});
const stored = group(
	await db.projectScoreByFieldTable.groupBy({ by: ["projectKey", "recordTable"], _sum: { pointsAwarded: true, pointsAvailable: true } }),
	(r) => r.projectKey,
);
const stakeholders = await db.stakeholderTable.findMany({ where: { deletedAt: null, projectKey: { not: null } }, select: { projectKey: true, organizationKey: true } });
const organizations = new Map(
	(await db.organizationTable.findMany({ where: { deletedAt: null }, select: { organizationKey: true, ...pick(OFFERED.OrganizationTable) } })).map((o) => [o.organizationKey, o]),
);
const named = [...new Set(stakeholders.map((s) => s.organizationKey))].filter((k) => organizations.has(k)).sort();
const current = await currentClaims(db, named);
const claims = group(
	await db.claimTable.findMany({ where: { claimKey: { in: current.map((c) => c.claimKey) } }, select: { claimKey: true, organizationKey: true, ...pick(OFFERED.ClaimTable) } }),
	(c) => c.organizationKey,
);
const crops = group(
	await db.cropTable.findMany({
		where: { deletedAt: null, projectKey: { not: null } },
		select: { projectKey: true, SpeciesTable: { where: { deletedAt: null }, select: { speciesName: true, ...pick(OFFERED.SpeciesTable) } } },
	}),
	(c) => c.projectKey,
);
const partners = group(stakeholders, (s) => s.projectKey);

const tallyOf = (scores: FieldScore[]): Tally => {
	const tally: Tally = {};
	for (const s of scores) {
		const line = (tally[s.recordTable] ??= { scored: 0, available: 0 });
		line.scored += s.pointsAwarded;
		line.available += s.pointsAvailable;
	}
	return tally;
};

const unscored: string[] = [];
const rows: Row[] = [];
for (const project of projects) {
	const key = project.projectKey;
	const mine = stored.get(key);
	if (!mine) {
		unscored.push(key);
		continue;
	}
	const tables: Tally = Object.fromEntries(mine.map((r) => [r.recordTable, { scored: r._sum.pointsAwarded ?? 0, available: r._sum.pointsAvailable ?? 0 }]));
	const orgs = [...new Set((partners.get(key) ?? []).map((s) => s.organizationKey))].sort().flatMap((k) => organizations.get(k) ?? []);
	const species = new Map((crops.get(key) ?? []).flatMap((c) => c.SpeciesTable).map((s) => [s.speciesName, s]));
	Object.assign(
		tables,
		tallyOf(
			fieldScores(
				key,
				{
					...Object.fromEntries(STORED.filter((table) => !tables[table] && OFFERED[table]).map((table) => [table, []])),
					SpeciesTable: [...species.values()],
					OrganizationTable: orgs,
					ClaimTable: orgs.flatMap((o) => claims.get(o.organizationKey) ?? []),
				},
				points,
			),
		),
	);
	const scored = Object.values(tables).reduce((sum, t) => sum + t.scored, 0);
	const available = Object.values(tables).reduce((sum, t) => sum + t.available, 0);
	rows.push({
		key,
		name: project.projectName,
		platform: project.platformId,
		was: project.scoreProject === null ? null : Number(project.scoreProject),
		now: available > 0 ? scored / available : 0,
		scored,
		available,
		tables,
	});
}

// The stored rows must be the score each project carries, or "was" and "now" are not the same records.
const drifted = rows.filter((r) => {
	const p = projects.find((x) => x.projectKey === r.key);
	const before = STORED.reduce((sum, t) => sum + (stored.get(r.key)?.find((s) => s.recordTable === t)?._sum.pointsAvailable ?? 0), 0);
	return p?.scorePointsAvailable !== before;
}).length;

const differs: string[] = [];
for (let i = 0; i < check; i++) {
	const row = rows[Math.floor(((i + 0.5) * rows.length) / check)];
	const project = await db.projectTable.findUniqueOrThrow({ where: { projectKey: row.key } });
	const real = tallyOf(projectFieldScores(row.key, { ProjectTable: [project], ...(await recordsOf(db, [row.key])) }, points));
	if (JSON.stringify(Object.entries(real).sort()) !== JSON.stringify(Object.entries(row.tables).sort())) differs.push(row.key);
}
await db.$disconnect();
await pool.end();

const both = rows.filter((r): r is Row & { was: number } => r.was !== null);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** The method's percentile: the share scoring at or below, as a whole number. */
const percentiles = (xs: number[]) => {
	const sorted = [...xs].sort((a, b) => a - b);
	const atOrBelow = (x: number) => {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid] <= x) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	return xs.map((x) => Math.round((atOrBelow(x) / xs.length) * 100));
};
/** Average rank, ties shared: what Spearman's correlation is taken over. */
const ranks = (xs: number[]) => {
	const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
	const ranked = new Array<number>(xs.length);
	for (let i = 0; i < order.length; ) {
		let j = i;
		while (j < order.length && order[j][0] === order[i][0]) j++;
		for (let k = i; k < j; k++) ranked[order[k][1]] = (i + j - 1) / 2;
		i = j;
	}
	return ranked;
};
const correlation = (a: number[], b: number[]) => {
	const ma = mean(a);
	const mb = mean(b);
	const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
	return cov / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
};

const was = both.map((r) => r.was);
const now = both.map((r) => r.now);
const before = percentiles(was);
const moved = percentiles(now).map((p, i) => Math.abs(p - before[i]));
const top = (xs: number[]) => new Set(xs.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0]).slice(0, Math.floor(xs.length / 10)).map(([, i]) => i));
const topWas = top(was);
const platforms: Record<string, { projects: number; was: number; now: number }> = {};
for (const platform of [...new Set(both.map((r) => r.platform ?? "none"))].sort()) {
	const mine = both.filter((r) => (r.platform ?? "none") === platform);
	platforms[platform] = { projects: mine.length, was: mean(mine.map((r) => r.was)), now: mean(mine.map((r) => r.now)) };
}
const tablesWith = (table: string) => rows.filter((r) => r.tables[table].scored > 0).length;

const report = {
	projects: projects.length,
	compared: both.length,
	unscored: unscored.length,
	storedRowsDrifted: drifted,
	checked: { projects: check, differs },
	mean: { was: mean(was), now: mean(now) },
	median: { was: median(was), now: median(now) },
	available: { min: Math.min(...rows.map((r) => r.available)), median: median(rows.map((r) => r.available)), max: Math.max(...rows.map((r) => r.available)) },
	rankCorrelation: correlation(ranks(was), ranks(now)),
	movedOver10: moved.filter((m) => m > 10).length,
	movedOver20: moved.filter((m) => m > 20).length,
	topTenth: { size: topWas.size, kept: [...top(now)].filter((i) => topWas.has(i)).length },
	earnsAnything: Object.fromEntries([...Object.keys(OFFERED), ...Object.keys(BONUSABLE)].map((table) => [table, tablesWith(table)])),
	platforms,
	watched: Object.fromEntries(rows.filter((r) => WATCH.has(r.key)).map((r) => [r.key, r])),
};
console.log(JSON.stringify(report, null, 1));
writeFileSync(out, JSON.stringify({ report, rows }));
