// CLI entry point for the score matrix: makes ScoreMatrixTable equal
// scoreMatrix.ts and prints it. Every score run does the same first.
//
//   tsx ../ReTreever_ratings/seedScoreMatrix.ts      (from the parent repo)
//
// Separate from scoreMatrix.ts so that a module importing the matrix never
// carries this file's top-level await into a bundle that cannot lower it.

import { closeScoreDb, scoreDb } from "./scoreDb.js";
import { matrixHash, seedScoreMatrix } from "./scoreMatrix.js";

const db = scoreDb();
const changed = await seedScoreMatrix(db);
console.log(`ScoreMatrixTable mirrors scoreMatrix.ts (${changed} row(s) changed, matrix ${matrixHash().slice(0, 12)}):`);
for (const row of await db.scoreMatrixTable.findMany({
	orderBy: [{ pointsAvailable: "desc" }, { fieldName: "asc" }],
})) {
	console.log(`  ${row.fieldName}: ${row.pointsAvailable} pts`);
}
console.log("\nTo change a weight, edit scoreMatrix.ts and commit.");
await closeScoreDb();
process.exit(0);
