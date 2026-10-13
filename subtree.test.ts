import { describe, expect, it } from "vitest";
import { MAX_DEPTH, orgSubtree, walkDown } from "./subtree";

// parent → children, in memory; the walk asks for a whole level at once.
const tree = (edges: Record<string, string[]>) => async (parents: string[]) =>
	parents.flatMap((p) => edges[p] ?? []);

const chain = (levels: number) =>
	Object.fromEntries(
		Array.from({ length: levels }, (_, i) => [`n${i}`, [`n${i + 1}`]]),
	);

describe("walkDown", () => {
	it("returns the root and every descendant across three levels", async () => {
		const keys = await walkDown(
			"p",
			tree({ p: ["a", "b"], a: ["a1", "a2"], a1: ["a1x"], b: [] }),
		);
		expect(keys).toEqual(["p", "a", "b", "a1", "a2", "a1x"]);
	});

	it("is just the root for a lone listing", async () => {
		expect(await walkDown("lone", tree({}))).toEqual(["lone"]);
	});

	it("throws on a cycle below the root instead of looping", async () => {
		await expect(
			walkDown("p", tree({ p: ["a"], a: ["b"], b: ["a"] })),
		).rejects.toThrow(/loops back through a/);
	});

	it("throws on a cycle back through the root", async () => {
		await expect(
			walkDown("p", tree({ p: ["a"], a: ["p"] })),
		).rejects.toThrow(/loops back through p/);
	});

	it(`allows ${MAX_DEPTH} levels and throws on the next`, async () => {
		expect(await walkDown("n0", tree(chain(MAX_DEPTH)))).toHaveLength(
			MAX_DEPTH + 1,
		);
		await expect(walkDown("n0", tree(chain(MAX_DEPTH + 1)))).rejects.toThrow(
			/deeper than/,
		);
	});
});

// A stub delegate: answers a level query from `edges`, records the WHERE.
function stubTable<K extends string>(
	keyField: K,
	parentField: string,
	edges: Record<string, string[]>,
) {
	const wheres: Record<string, unknown>[] = [];
	return {
		wheres,
		findMany: async (args: { where: Record<string, { in: string[] }> }) => {
			wheres.push(args.where);
			return args.where[parentField].in.flatMap((p) =>
				(edges[p] ?? []).map((k) => ({ [keyField]: k })),
			);
		},
	};
}

describe("orgSubtree", () => {
	it("asks for the live children of the whole frontier at once", async () => {
		const t = stubTable("organizationKey", "organizationParentKey", {
			p: ["a", "b"],
			a: ["a1"],
		});
		const keys = await orgSubtree({ organizationTable: t } as never, "p");

		expect(keys).toEqual(["p", "a", "b", "a1"]);
		expect(t.wheres).toEqual([
			{ organizationParentKey: { in: ["p"] }, deletedAt: null },
			{ organizationParentKey: { in: ["a", "b"] }, deletedAt: null },
			{ organizationParentKey: { in: ["a1"] }, deletedAt: null },
		]);
	});
});
