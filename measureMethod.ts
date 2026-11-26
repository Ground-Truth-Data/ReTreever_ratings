/**
 * What the method in projectScore.ts would do to every live project and every
 * ranked organization, against what each one stores. Reads only: it calls no
 * scorer that writes, and every connection it opens refuses a write.
 *
 * The tables whose fields grade by their words, and the ones reached through a
 * project's records, are read whole in a few queries and scored here by the
 * method's own `projectFieldScores`. The other five tables' stored by-field
 * rows already hold each record's verdict, so they are summed, not re-derived,
 * scaled from the stored run's weights to today's: ten queries over two
 * connections instead of ten per project over the whole pool. An org's score
 * is re-weighted from its stored inputs with its stored disclosure ratio, and
 * ranked as `rankOrgs` ranks it. `--check n` scores n projects from their
 * records by `recordsOf` and lists any that differs.
 *
 *   cd ReTreever && npx varlock run -- npx tsx ../ReTreever_ratings/measureMethod.ts <out.json> [--check n] [projectKey…]
 */
import { writeFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { ratingState } from "$parent/siblings/ReTreever_who_what/lib/rating/ratingState.js";
import { currentClaims } from "./orgScore.js";
import { type FieldScore, fieldPoints, fieldScores, OFFERED, projectFieldScores, recordsOf } from "./projectScore.js";
import config from "./scoreConfig.json" with { type: "json" };
import { matrixPoints, METHODOLOGY_VERSION } from "./scoreMatrix.js";

type Tally = Record<string, { scored: number; available: number }>;
type Row = { key: string; name: string; platform: string; was: number | null; now: number; scored: number; available: number; tables: Tally };

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

/** Scored here from their records; every other table's verdicts are stored. */
const READ = ["ProjectTable", "LandTable", "CropTable", "SpeciesTable", "OrganizationTable", "ClaimTable", "SourceTable"];
const STORED = Object.keys(OFFERED).filter((table) => !READ.includes(table));
/** The stored rows' weights are today's over this: version 4 scaled every weight by ten. */
const STORED_SCALE: Record<string, number> = { "3": 10, [METHODOLOGY_VERSION]: 1 };

const pick = (fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, true]));
const group = <T>(rows: T[], key: (row: T) => string | null) => {
	const by = new Map<string, T[]>();
	for (const row of rows) {
		const k = key(row);
		if (k === null) continue;
		const list = by.get(k);
		if (list) list.push(row);
		else by.set(k, [row]);
	}
	return by;
};
const live = { deletedAt: null };

const projects = await db.projectTable.findMany({
	where: live,
	select: { projectKey: true, projectName: true, platformId: true, scoreProject: true, scorePointsAvailable: true, scoreProjectRank: true, ...pick(OFFERED.ProjectTable) },
	orderBy: { projectKey: "asc" },
});

const runs = await db.projectScoreByFieldTable.groupBy({ by: ["scoreRunId"], where: { recordTable: { in: STORED } }, _count: true });
const versions = new Map(
	(await db.scoreRunTable.findMany({ where: { scoreRunId: { in: runs.flatMap((r) => r.scoreRunId ?? []) } }, select: { scoreRunId: true, methodologyVersion: true } })).map((r) => [
		r.scoreRunId,
		r.methodologyVersion,
	]),
);
const storedVersions = [...new Set(runs.map((r) => (r.scoreRunId ? versions.get(r.scoreRunId) : undefined) ?? "none"))];
if (storedVersions.length !== 1 || !(storedVersions[0] in STORED_SCALE)) throw new Error(`stored rows from methodology ${storedVersions.join(", ")}: no one scale to today's weights`);
const scale = STORED_SCALE[storedVersions[0]];
const stored = group(
	await db.projectScoreByFieldTable.groupBy({
		by: ["projectKey", "recordTable"],
		where: { recordTable: { in: STORED } },
		_sum: { pointsAwarded: true, pointsAvailable: true },
	}),
	(r) => r.projectKey,
);
const scored = new Set(
	(await db.projectScoreByFieldTable.groupBy({ by: ["projectKey"], _count: true })).map((r) => r.projectKey),
);

const lands = group(await db.landTable.findMany({ where: live, select: { landKey: true, projectKey: true, ...pick(OFFERED.LandTable) } }), (l) => l.projectKey);
const crops = group(
	await db.cropTable.findMany({
		where: { ...live, projectKey: { not: null } },
		select: {
			cropKey: true,
			projectKey: true,
			...pick(OFFERED.CropTable.filter((f) => f !== "speciesName")),
			SpeciesTable: { where: live, select: { speciesName: true, ...pick(OFFERED.SpeciesTable) } },
		},
	}),
	(c) => c.projectKey,
);
const sources = group(
	await db.sourceTable.findMany({
		where: { ...live, projectKey: { not: null } },
		select: { sourceKey: true, projectKey: true, url: true, urlType: true, disclosureType: true, sourceDesc: true, sourceCredit: true, stakeholderCategoryId: true },
	}),
	(s) => s.projectKey,
);
const stakeholders = await db.stakeholderTable.findMany({ where: { ...live, projectKey: { not: null } }, select: { projectKey: true, organizationKey: true } });
const organizations = new Map(
	(await db.organizationTable.findMany({ where: live, select: { organizationKey: true, ...pick(OFFERED.OrganizationTable) } })).map((o) => [o.organizationKey, o]),
);
const named = [...new Set(stakeholders.map((s) => s.organizationKey))].filter((k) => organizations.has(k)).sort();
const current = await currentClaims(db, named);
const claims = group(
	await db.claimTable.findMany({ where: { claimKey: { in: current.map((c) => c.claimKey) } }, select: { claimKey: true, organizationKey: true, ...pick(OFFERED.ClaimTable) } }),
	(c) => c.organizationKey,
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
	if (!scored.has(key)) {
		unscored.push(key);
		continue;
	}
	const kept: Tally = Object.fromEntries(
		(stored.get(key) ?? []).map((r) => [r.recordTable, { scored: (r._sum.pointsAwarded ?? 0) * scale, available: (r._sum.pointsAvailable ?? 0) * scale }]),
	);
	const projectCrops = crops.get(key) ?? [];
	const orgs = [...new Set((partners.get(key) ?? []).map((s) => s.organizationKey))].sort().flatMap((k) => organizations.get(k) ?? []);
	const { platformId: _p, scoreProject: _s, scorePointsAvailable: _a, scoreProjectRank: _r, ...own } = project;
	const tables: Tally = {
		...kept,
		...tallyOf(fieldScores(key, Object.fromEntries(STORED.filter((table) => !kept[table]).map((table) => [table, []])), points)),
		...tallyOf(
			projectFieldScores(
				key,
				{
					ProjectTable: [own],
					LandTable: lands.get(key) ?? [],
					CropTable: projectCrops.map(({ SpeciesTable: linked, ...crop }) => ({ ...crop, speciesName: linked[0]?.speciesName ?? null })),
					SpeciesTable: [...new Map(projectCrops.flatMap((c) => c.SpeciesTable).map((s) => [s.speciesName, s])).values()],
					OrganizationTable: orgs,
					ClaimTable: orgs.flatMap((o) => claims.get(o.organizationKey) ?? []),
					SourceTable: sources.get(key) ?? [],
				},
				points,
			),
		),
	};
	const earned = Object.values(tables).reduce((sum, t) => sum + t.scored, 0);
	const available = Object.values(tables).reduce((sum, t) => sum + t.available, 0);
	rows.push({
		key,
		name: project.projectName,
		platform: project.platformId ?? "none",
		was: project.scoreProject === null ? null : Number(project.scoreProject),
		now: available > 0 ? earned / available : 0,
		scored: earned,
		available,
		tables,
	});
}

const differs: string[] = [];
for (let i = 0; i < check; i++) {
	const row = rows[Math.floor(((i + 0.5) * rows.length) / check)];
	const project = await db.projectTable.findUniqueOrThrow({ where: { projectKey: row.key } });
	const real = tallyOf(projectFieldScores(row.key, { ProjectTable: [project], ...(await recordsOf(db, [row.key])) }, points));
	if (JSON.stringify(Object.entries(real).sort()) !== JSON.stringify(Object.entries(row.tables).sort())) differs.push(row.key);
}

// The ranked orgs as the last org run left them, and what each averaged.
const ranked = await db.organizationTable.findMany({
	where: { ...live, scorePercentile: { not: null } },
	select: { organizationKey: true, primaryStakeholderCategory: true, scoreOrgFinal: true, scoreRatioDisclosure: true, scoreCohort: true, scorePercentile: true },
});
const inputs = group(
	await db.orgScoreInputTable.findMany({
		where: { organizationKey: { in: ranked.map((o) => o.organizationKey) } },
		select: { organizationKey: true, projectKey: true, scoreProject: true, scorePointsAvailable: true },
	}),
	(r) => r.organizationKey,
);
await db.$disconnect();
await pool.end();

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** CUME_DIST over `xs`: the share at or below each. */
const cumeDist = (xs: number[]) => {
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
	return xs.map((x) => atOrBelow(x) / xs.length);
};
/** The project percentile, as `rank_projects` stores it. */
const percentiles = (xs: number[]) => cumeDist(xs).map((p) => Math.round(p * 100));
/** Average rank, ties shared: what Spearman's correlation is taken over. */
const ranks = (xs: number[]) => {
	const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
	const out = new Array<number>(xs.length);
	for (let i = 0; i < order.length; ) {
		let j = i;
		while (j < order.length && order[j][0] === order[i][0]) j++;
		for (let k = i; k < j; k++) out[order[k][1]] = (i + j - 1) / 2;
		i = j;
	}
	return out;
};
const correlation = (a: number[], b: number[]) => {
	const ma = mean(a);
	const mb = mean(b);
	const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
	return cov / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
};
const count = <T>(xs: T[]) => {
	const by = new Map<T, number>();
	for (const x of xs) by.set(x, (by.get(x) ?? 0) + 1);
	return by;
};

const storedRank = new Map(projects.map((p) => [p.projectKey, p.scoreProjectRank]));
const both = rows.filter((r): r is Row & { was: number } => r.was !== null);
const was = both.map((r) => r.was);
const now = both.map((r) => r.now);
const pWas = percentiles(was);
const pNow = percentiles(now);

/** Ties, gaps and the four words for one set of scores and their percentiles. */
const spread = (scores: number[], ps: number[]) => {
	const ties = [...count(scores)].sort((a, b) => b[1] - a[1]);
	const [score, size] = ties[0];
	const block = both.filter((_, i) => scores[i] === score);
	const held = new Set(ps);
	const words = count<string>(ps.map((p) => ratingState(p) ?? "none"));
	return {
		distinct: ties.length,
		distinctBySite: Object.fromEntries(["c", "m", "b"].map((site) => [site, new Set(scores.filter((_, i) => both[i].platform === site)).size])),
		biggestTie: { projects: size, share: size / scores.length, score, percentile: ps[scores.indexOf(score)], sites: Object.fromEntries(count(block.map((r) => r.platform))) },
		tiesOver2pct: ties.filter(([, n]) => n > 0.02 * scores.length).length,
		emptyPercentiles: Array.from({ length: 100 }, (_, i) => i + 1).filter((p) => !held.has(p)).length,
		words: Object.fromEntries(["opaque", "partial", "open", "transparent"].map((w) => [w, (words.get(w) ?? 0) / ps.length])),
	};
};

const moved = pNow.map((p, i) => Math.abs(p - pWas[i]));
const movedBySite: Record<string, { projects: number; over10: number; over25: number }> = {};
both.forEach((r, i) => {
	const site = (movedBySite[r.platform] ??= { projects: 0, over10: 0, over25: 0 });
	site.projects++;
	if (moved[i] > 10) site.over10++;
	if (moved[i] > 25) site.over25++;
});
const top = (xs: number[]) => new Set(xs.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0]).slice(0, Math.floor(xs.length / 10)).map(([, i]) => i));
const topWas = top(was);
const platforms: Record<string, { projects: number; was: number; now: number }> = {};
for (const platform of [...new Set(both.map((r) => r.platform))].sort()) {
	const mine = both.filter((r) => r.platform === platform);
	platforms[platform] = { projects: mine.length, was: mean(mine.map((r) => r.was)), now: mean(mine.map((r) => r.now)) };
}

// Orgs: each one's weighted mean over its stored inputs, re-weighted by the projects' new scores and points.
const byKey = new Map(rows.map((r) => [r.key, r]));
const weighted = (list: { score: number | null; weight: number }[]) => {
	let w = 0;
	let s = 0;
	for (const { score, weight } of list) {
		if (score === null || !(weight > 0)) continue;
		w += weight;
		s += score * weight;
	}
	return w > 0 ? s / w : null;
};
const orgs = ranked.map((o) => {
	const mine = inputs.get(o.organizationKey) ?? [];
	const ratio = o.scoreRatioDisclosure === null ? 1 : Number(o.scoreRatioDisclosure);
	const wasMean = weighted(mine.map((p) => ({ score: p.scoreProject === null ? null : Number(p.scoreProject), weight: Number(p.scorePointsAvailable ?? 0) })));
	const nowMean = weighted(
		mine.map((p) => {
			const r = byKey.get(p.projectKey);
			return r ? { score: r.now, weight: r.available } : { score: null, weight: 0 };
		}),
	);
	return {
		key: o.organizationKey,
		category: o.primaryStakeholderCategory ?? "",
		stored: { final: o.scoreOrgFinal === null ? null : Number(o.scoreOrgFinal), percentile: Number(o.scorePercentile) },
		was: wasMean === null ? null : wasMean * ratio,
		now: nowMean === null ? null : nowMean * ratio,
		available: mine.reduce((sum, p) => sum + (byKey.get(p.projectKey)?.available ?? 0), 0),
	};
});
/** `rankOrgs`: CUME_DIST within the category, over every ranked org for a category under the minimum. */
const orgPercentiles = (finals: (number | null)[]) => {
	const out = new Array<number | null>(finals.length).fill(null);
	const all = finals.map((f, i) => [f, i] as const).filter((x): x is readonly [number, number] => x[0] !== null);
	const pAll = cumeDist(all.map(([f]) => f));
	const overall = new Map(all.map(([, i], j) => [i, pAll[j]]));
	for (const members of group(all, ([, i]) => orgs[i].category).values()) {
		if (members.length < config.minCategoryGroup) for (const [, i] of members) out[i] = overall.get(i) ?? null;
		else {
			const p = cumeDist(members.map(([f]) => f));
			members.forEach(([, i], j) => {
				out[i] = p[j];
			});
		}
	}
	return out;
};
const orgWas = orgPercentiles(orgs.map((o) => o.was));
const orgNow = orgPercentiles(orgs.map((o) => o.now));
const orgMoves = orgs.map((_, i) => (orgWas[i] === null || orgNow[i] === null ? null : Math.abs((orgNow[i] as number) - (orgWas[i] as number)) * 100));
const reproduced = orgs.filter((o, i) => orgWas[i] !== null && Math.abs((orgWas[i] as number) - o.stored.percentile) < 1e-6).length;

const report = {
	methodologyVersion: METHODOLOGY_VERSION,
	storedRows: { methodologyVersion: storedVersions[0], scale },
	projects: projects.length,
	compared: both.length,
	unscored: unscored.length,
	storedPercentileReproduced: both.filter((r, i) => storedRank.get(r.key) === pWas[i]).length,
	checked: { projects: check, differs },
	mean: { was: mean(was), now: mean(now) },
	median: { was: median(was), now: median(now) },
	available: { min: Math.min(...rows.map((r) => r.available)), median: median(rows.map((r) => r.available)), max: Math.max(...rows.map((r) => r.available)) },
	was: spread(was, pWas),
	now: spread(now, pNow),
	rankCorrelation: correlation(ranks(was), ranks(now)),
	movedOver10: moved.filter((m) => m > 10).length,
	movedOver25: moved.filter((m) => m > 25).length,
	movedBySite,
	topTenth: { size: topWas.size, kept: [...top(now)].filter((i) => topWas.has(i)).length },
	platforms,
	orgs: {
		ranked: orgs.length,
		storedPercentileReproduced: reproduced,
		movedOver10: orgMoves.filter((m) => m !== null && m > 10).length,
		movedOver25: orgMoves.filter((m) => m !== null && m > 25).length,
		medianMove: median(orgMoves.filter((m): m is number => m !== null)),
		maxPointsAvailable: Math.max(...orgs.map((o) => o.available)),
	},
	watched: Object.fromEntries(rows.filter((r) => WATCH.has(r.key)).map((r) => [r.key, r])),
};
console.log(JSON.stringify(report, null, 1));
writeFileSync(out, JSON.stringify({ report, rows, orgs }));
