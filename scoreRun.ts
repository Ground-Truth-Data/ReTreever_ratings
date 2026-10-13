/** Transient connection errors worth a retry — a real bug (bad data, schema
 * mismatch) still fails fast. */
function isTransient(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket disconnected|Connection terminated|Timed out fetching a new connection/i.test(
		msg,
	);
}

/** Retries only transient errors, with backoff — a long run expects one blip. */
export async function withRetry<T>(
	fn: () => Promise<T>,
	label: string,
	attempts = 3,
): Promise<T> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (attempt === attempts || !isTransient(e)) throw e;
			const delayMs = 1000 * 2 ** (attempt - 1);
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(
				`⚠️  ${label} failed (attempt ${attempt}/${attempts}, retrying in ${delayMs}ms): ${msg}`,
			);
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	throw new Error("unreachable");
}

/**
 * Scores batch after batch until `nextBatch` returns none. `nextBatch` gets
 * how many keys were already tried (the offset into a --full snapshot) and
 * the keys that failed, so a dirty-mode query can leave them out: a failed
 * row keeps its flag and would otherwise come back forever.
 */
export async function scoreInBatches(
	noun: string,
	total: number,
	nextBatch: (tried: number, failed: string[]) => Promise<string[]>,
	scoreBatch: (keys: string[]) => Promise<string[]>,
): Promise<{ scored: number; failed: string[] }> {
	let tried = 0;
	const failed: string[] = [];
	for (let batch = 1; ; batch++) {
		const keys = await nextBatch(tried, failed);
		if (keys.length === 0) break;
		console.log(`\n📦 Batch ${batch}: ${keys.length} ${noun} (${total - tried} remaining)`);
		failed.push(...(await scoreBatch(keys)));
		tried += keys.length;
	}
	const scored = tried - failed.length;
	if (failed.length === 0) console.log(`\n✅ All ${noun} scored. Total: ${scored}`);
	else
		console.warn(
			`\n⚠️  Scored ${scored} of ${tried} ${noun}. ${failed.length} failed after retries and were NOT scored:\n  ${failed.join("\n  ")}`,
		);
	return { scored, failed };
}
