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
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { namePool } from "$parent/src/lib/server/runLock.js";
import { matrixHash, METHODOLOGY_VERSION, seedScoreMatrix } from "./scoreMatrix.js";

const RATINGS_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(RATINGS_DIR, "scoreConfig.json");

export const scoreConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));

/** sha256 of scoreConfig.json as read. */
export function configHash(): string {
	return crypto.createHash("sha256").update(readFileSync(CONFIG_FILE)).digest("hex");
}

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

const git = (...args: string[]) =>
	execFileSync("git", ["-C", RATINGS_DIR, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** This repo's commit, and whether the tree differs from it. A dirty tree is
 * stamped, not refused: the row says the sha alone cannot reproduce it. */
export function ratingsTree(): { ratingsSha: string; dirty: boolean } {
	return { ratingsSha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
}

export type ScoreRunDb = Pick<PrismaClient, "scoreRunTable" | "foundrRunTable" | "scoreMatrixTable">;

/**
 * Starts a score run: the weights table is made equal to git, then one
 * ScoreRunTable row records what this run scores with. Its id goes on every
 * score row the run writes. The Foundr run is the one the process carries
 * (`FOUNDR_RUN_ID`, set when the orchestrator scores inside its own run), else
 * the newest, whose upsert set the flags being scored; its per-site ledger
 * hashes, hashed together, are the ledgers behind those rows.
 */
export async function openScoreRun(db: ScoreRunDb): Promise<string> {
	await seedScoreMatrix(db);
	const select = { runId: true, ledgerHashes: true };
	const carried = process.env.FOUNDR_RUN_ID;
	const foundrRun = carried
		? await db.foundrRunTable.findUnique({ where: { runId: carried }, select })
		: await db.foundrRunTable.findFirst({ orderBy: { startedAt: "desc" }, select });
	const ledgerHash = foundrRun
		? crypto.createHash("sha256").update(JSON.stringify(foundrRun.ledgerHashes)).digest("hex")
		: null;
	const { scoreRunId } = await db.scoreRunTable.create({
		data: {
			...ratingsTree(),
			matrixHash: matrixHash(),
			configHash: configHash(),
			methodologyVersion: METHODOLOGY_VERSION,
			foundrRunId: foundrRun?.runId ?? null,
			ledgerHash,
		},
		select: { scoreRunId: true },
	});
	return scoreRunId;
}
