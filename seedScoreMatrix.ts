// CLI entry point for the score matrix. Seeds an empty ScoreMatrixTable, or
// prints the live DB weights when it already has rows.
//
//   tsx ../ReTreever_ratings/seedScoreMatrix.ts      (from the parent repo)
//
// Separate from scoreMatrix.ts so that a module importing the matrix never
// carries this file's top-level await into a bundle that cannot lower it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { seedScoreMatrixIfEmpty } from "./scoreMatrix";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = JSON.parse(
	readFileSync(join(__dirname, "scoreConfig.json"), "utf8"),
);

const connectionString = process.env.GC_RT_supabase_dev_session;
if (!connectionString)
	throw new Error("GC_RT_supabase_dev_session is not set!");

const pool = new pg.Pool({
	connectionString,
	max: config.pool.maxConnections,
	ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const seeded = await seedScoreMatrixIfEmpty(prisma);

if (seeded === 0) {
	const live = await prisma.scoreMatrixTable.findMany({
		orderBy: [{ pointsAvailable: "desc" }, { fieldName: "asc" }],
	});
	console.log(
		`ScoreMatrixTable already populated — ${live.length} live weights (DB is source of truth):`,
	);
	for (const row of live) {
		console.log(`  ${row.fieldName}: ${row.pointsAvailable} pts`);
	}
	console.log(
		"\nNothing written. To change a weight, UPDATE the row in the DB.",
	);
}

console.log("Done.");
await pool.end();
process.exit(0);
