import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { SCORE_MATRIX, seedScoreMatrix } from "./scoreMatrix";

// ScoreMatrixTable against ReTreever's real schema: a mirror of the file, whatever it held before.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const gitRows = Object.entries(SCORE_MATRIX)
	.map(([fieldName, { points, description }]) => ({ fieldName, pointsAvailable: points, description }))
	.sort((a, b) => (a.fieldName < b.fieldName ? -1 : 1));
const tableRows = () =>
	t.prisma.scoreMatrixTable.findMany({
		select: { fieldName: true, pointsAvailable: true, description: true },
		orderBy: { fieldName: "asc" },
	});

describe("seedScoreMatrix: the table mirrors the file", () => {
	it("fills an empty table, then changes nothing on a second seed", async () => {
		expect(await seedScoreMatrix(t.prisma)).toBe(gitRows.length);
		expect(await tableRows()).toEqual(gitRows);
		expect(await seedScoreMatrix(t.prisma)).toBe(0);
	});

	it("puts a hand-edited weight back, drops a row git does not have, and leaves an equal row's edit time alone", async () => {
		await seedScoreMatrix(t.prisma);
		const before = await t.prisma.scoreMatrixTable.findUniqueOrThrow({ where: { fieldName: "latitude" } });
		await t.prisma.scoreMatrixTable.update({ where: { fieldName: "geometry" }, data: { pointsAvailable: 25 } });
		await t.prisma.scoreMatrixTable.create({ data: { fieldName: "hectares", pointsAvailable: 9 } });

		expect(await seedScoreMatrix(t.prisma)).toBe(2);
		expect(await tableRows()).toEqual(gitRows);
		expect((await t.prisma.scoreMatrixTable.findUniqueOrThrow({ where: { fieldName: "latitude" } })).lastEditedAt).toEqual(before.lastEditedAt);
	});
});
