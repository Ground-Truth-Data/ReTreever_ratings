import crypto from "node:crypto";
import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";

/** A project pair whose latest human answer folds it: `sameAs` or `partOf:<wholeKey>`. */
export type FoldPair = { keyA: string; keyB: string; resolution: string };

const folds = (resolution: string) => resolution === "sameAs" || resolution.startsWith("partOf:");

/**
 * Every project pair a person has folded. A pair holds a row per method; its
 * answer is the latest human decision across them, so a later `rejected`
 * unfolds it. Jev's resolutions are not a person's and never count.
 */
export async function foldPairs(db: Pick<PrismaClient, "$queryRaw">): Promise<FoldPair[]> {
	const latest = await db.$queryRaw<FoldPair[]>`
		SELECT DISTINCT ON ("keyA", "keyB") "keyA", "keyB", resolution
		FROM "LinkCandidateTable"
		WHERE "table" = 'ProjectTable' AND "resolvedAt" IS NOT NULL
		  AND (resolution IN ('linked', 'rejected', 'sameAs') OR resolution LIKE 'partOf:%')
		ORDER BY "keyA", "keyB", "resolvedAt" DESC, resolution
	`;
	return latest.filter((p) => folds(p.resolution));
}

/** sha256 of the folded pairs, sorted here: the query's order follows the database's collation. */
export function pairsHash(pairs: FoldPair[]): string {
	const rows = pairs.map((p) => [p.keyA, p.keyB, p.resolution]).sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : 1));
	return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** The folded pairs a run is stamped with; a pair answered since then would score rows the stamp does not name. */
export async function runPairs(db: Pick<PrismaClient, "$queryRaw" | "scoreRunTable">, scoreRunId: string): Promise<FoldPair[]> {
	const pairs = await foldPairs(db);
	const { pairsHash: stamped } = await db.scoreRunTable.findUniqueOrThrow({ where: { scoreRunId }, select: { pairsHash: true } });
	if (pairsHash(pairs) !== stamped) throw new Error(`Run ${scoreRunId}: a project pair was answered after it opened. Score again: gitEr/CLI.sh score`);
	return pairs;
}

/**
 * The keys grouped into clusters by the folded pairs (union-find, so a chain
 * A–B–C is one cluster even when B is outside `keys`), each sorted, members
 * of `keys` only. A key no fold reaches is a cluster of one.
 */
export function clustersOf(keys: string[], pairs: FoldPair[]): string[][] {
	const parent = new Map<string, string>();
	const root = (k: string): string => {
		const p = parent.get(k) ?? k;
		if (p === k) return k;
		const r = root(p);
		parent.set(k, r);
		return r;
	};
	for (const { keyA, keyB } of pairs) {
		const [a, b] = [root(keyA), root(keyB)];
		if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
	}
	const byRoot = new Map<string, string[]>();
	for (const k of [...new Set(keys)].sort()) {
		const r = root(k);
		byRoot.set(r, [...(byRoot.get(r) ?? []), k]);
	}
	return [...byRoot.values()];
}
