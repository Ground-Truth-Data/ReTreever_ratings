/**
 * The one Prisma client every scorer module uses, so a process holds one pool
 * however many scorers it imports.
 *
 * It runs on the 6543 transaction pooler: a session-pooler client pins a
 * Postgres backend, and a --full run's ten starved dev Central's other users.
 * The run lock opens its own session connection. Foundr's orchestrator hands
 * in its own client instead, so a pipeline run never opens a second pool.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "$parent/prisma/generated/prisma-postgres/client.js";
import { foldPairs, pairsHash } from "./projectClusters.js";
import { logicDriftLines, scoreLogicDrift } from "./scoreLogic.js";
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
	const connectionString = process.env.GC_RT_supabase_dev_transaction;
	if (!connectionString) throw new Error("GC_RT_supabase_dev_transaction is not set!");
	ownPool = new pg.Pool({
		connectionString,
		max: scoreConfig.pool.maxConnections,
		ssl: { rejectUnauthorized: false },
		// A socket the pooler drops without a reset looks open forever: on 16 Nov a wave's project rescore
		// waited on one for over an hour, holding the wave. Keepalive finds it; the timeout bounds a statement.
		keepAlive: true,
		keepAliveInitialDelayMillis: 30_000,
		connectionTimeoutMillis: 30_000,
		query_timeout: 300_000,
	});
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

export type ScoreRunDb = Pick<PrismaClient, "scoreRunTable" | "foundrRunTable" | "scoreMatrixTable" | "$queryRaw">;

/** Prints which stored scores predate the tree's logic. Never stops a run: a check that fails says nothing. */
export async function warnLogicDrift(db: ScoreRunDb): Promise<void> {
	try {
		for (const line of logicDriftLines(await scoreLogicDrift(db))) console.warn(line);
	} catch {
		// A fake db, a dead git: the run goes on.
	}
}

/** What a run row says of the scorer and its inputs. The Foundr run is the one
 * the process carries (`FOUNDR_RUN_ID`, set when the orchestrator scores inside
 * its own run), else the newest, whose upsert set the flags being scored; its
 * per-site ledger hashes, hashed together, are the ledgers behind those rows;
 * the folded project pairs are hashed beside them. */
async function runStamp(db: ScoreRunDb) {
	const select = { runId: true, ledgerHashes: true };
	const carried = process.env.FOUNDR_RUN_ID;
	const foundrRun = carried
		? await db.foundrRunTable.findUnique({ where: { runId: carried }, select })
		: await db.foundrRunTable.findFirst({ orderBy: { startedAt: "desc" }, select });
	const ledgerHash = foundrRun
		? crypto.createHash("sha256").update(JSON.stringify(foundrRun.ledgerHashes)).digest("hex")
		: null;
	return {
		...ratingsTree(),
		matrixHash: matrixHash(),
		configHash: configHash(),
		methodologyVersion: METHODOLOGY_VERSION,
		foundrRunId: foundrRun?.runId ?? null,
		ledgerHash,
		pairsHash: pairsHash(await foldPairs(db)),
	};
}

/**
 * Starts a score run: the weights table is made equal to git, then one
 * ScoreRunTable row records what this run scores with. Its id goes on every
 * score row the run writes. Before it, the terminal is told which stored
 * scores an older scorer wrote.
 */
export async function openScoreRun(db: ScoreRunDb): Promise<string> {
	await warnLogicDrift(db);
	await seedScoreMatrix(db);
	const { scoreRunId } = await db.scoreRunTable.create({ data: await runStamp(db), select: { scoreRunId: true } });
	return scoreRunId;
}

/**
 * The run a project scorer left for the organisation scorer after it: the
 * newest row, when it is unfinished, no org was scored under it, no project is still dirty, and it is
 * stamped exactly as a row opened now would be. Null otherwise. Only the
 * newest, so a project run that died is passed over once its rerun opens a row
 * of its own, and stays unfinished.
 */
export async function projectRunToJoin(db: ScoreRunDb): Promise<string | null> {
	const newest = await db.scoreRunTable.findFirst({ orderBy: [{ at: "desc" }, { scoreRunId: "desc" }] });
	if (!newest || newest.completedAt) return null;
	const stamp = await runStamp(db);
	if ((Object.keys(stamp) as (keyof typeof stamp)[]).some((k) => newest[k] !== stamp[k])) return null;
	// A project still flagged dirty means the project run died before it finished: joining would hide that.
	const [{ closed }] = await db.$queryRaw<{ closed: boolean }[]>`
		SELECT EXISTS (SELECT 1 FROM "OrgScoreInputTable" WHERE "scoreRunId" = ${newest.scoreRunId})
			OR EXISTS (SELECT 1 FROM "ScoreClaimInputTable" WHERE "scoreRunId" = ${newest.scoreRunId})
			OR EXISTS (SELECT 1 FROM "ProjectTable" WHERE "scoreProjectFlag" AND "deletedAt" IS NULL) AS closed`;
	return closed ? null : newest.scoreRunId;
}

/** The organisation scorer's run: the project run just before it, so the
 * projects and the orgs averaged from them are one row that one snapshot
 * completes; a row of its own when there is none. */
export async function joinScoreRun(db: ScoreRunDb): Promise<string> {
	return (await projectRunToJoin(db)) ?? (await openScoreRun(db));
}
