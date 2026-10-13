import type { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";

/** Levels below a root before the walk gives up — unbounded, a cycle in the
 * parent column would spin the cron instead of failing it. */
export const MAX_DEPTH = 8;

type ChildrenOf = (parentKeys: string[]) => Promise<string[]>;

/**
 * `root` plus every descendant, breadth-first, one `childrenOf` call per
 * level. A key seen twice is a cycle (every row has one parent) and throws;
 * so does a ninth level.
 */
export async function walkDown(
	root: string,
	childrenOf: ChildrenOf,
): Promise<string[]> {
	const seen = new Set([root]);
	let frontier = [root];
	for (let depth = 1; ; depth++) {
		const next = await childrenOf(frontier);
		if (next.length === 0) return [...seen];
		if (depth > MAX_DEPTH)
			throw new Error(
				`subtree of ${root} is deeper than ${MAX_DEPTH} levels — a cycle in the parent column?`,
			);
		for (const key of next) {
			if (seen.has(key))
				throw new Error(`subtree of ${root} loops back through ${key}`);
			seen.add(key);
		}
		frontier = next;
	}
}

/** The org and every live org under it through `organizationParentKey`. */
export function orgSubtree(
	db: Pick<PrismaClient, "organizationTable">,
	organizationKey: string,
): Promise<string[]> {
	return walkDown(organizationKey, async (parents) =>
		(
			await db.organizationTable.findMany({
				where: { organizationParentKey: { in: parents }, deletedAt: null },
				select: { organizationKey: true },
			})
		).map((o) => o.organizationKey),
	);
}
