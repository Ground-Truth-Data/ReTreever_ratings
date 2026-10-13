/**
 * The one Prisma client every scorer module uses, so a process holds one pool
 * however many scorers it imports.
 *
 * Supavisor's session pooler refuses the 16th client outright ("max clients
 * are limited to pool_size: 15"). A run is this pool (`pool.maxConnections`)
 * plus the run lock's one connection, which leaves room for psql or Studio.
 * Foundr's orchestrator hands in its own client instead, so a pipeline run is
 * Foundr's pool plus the lock — never a second pool beside it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { namePool } from "$parent/src/lib/server/runLock.js";

export const scoreConfig = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scoreConfig.json"), "utf8"),
);

let client: PrismaClient | null = null;
let ownPool: pg.Pool | null = null;

/** Score through `db` — a caller's existing client — instead of opening a pool. */
export function useScoreDb(db: PrismaClient): void {
	client = db;
}

export function scoreDb(): PrismaClient {
	if (client) return client;
	const connectionString = process.env.GC_RT_supabase_dev_session;
	if (!connectionString) throw new Error("GC_RT_supabase_dev_session is not set!");
	ownPool = new pg.Pool({
		connectionString,
		max: scoreConfig.pool.maxConnections,
		ssl: { rejectUnauthorized: false },
	});
	namePool(ownPool, "score pool");
	client = new PrismaClient({ adapter: new PrismaPg(ownPool) });
	return client;
}

/** Ends the pool this module opened; a client handed in is its owner's to close. */
export async function closeScoreDb(): Promise<void> {
	if (!ownPool) return;
	await ownPool.end();
	ownPool = null;
	client = null;
}
