import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreInBatches, withRetry } from "./scoreRun";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("scoreInBatches", () => {
	it("counts what scored, and never prints the all-scored line over a failure", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const snapshot = ["a", "b", "c", "d", "e"];

		const result = await scoreInBatches(
			"projects",
			snapshot.length,
			async (tried) => snapshot.slice(tried, tried + 2),
			async (keys) => keys.filter((k) => k === "b" || k === "e"),
		);

		expect(result).toEqual({ scored: 3, failed: ["b", "e"] });
		expect(log.mock.calls.flat().join("\n")).not.toContain("✅ All");
	});

	it("says all scored when nothing failed", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const result = await scoreInBatches(
			"projects",
			3,
			async (tried) => ["a", "b", "c"].slice(tried, tried + 2),
			async () => [],
		);
		expect(result).toEqual({ scored: 3, failed: [] });
		expect(log.mock.calls.flat().join("\n")).toContain("✅ All projects scored. Total: 3");
	});

	it("hands the failed keys to the next query, so a dirty-mode run ends", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const flagged = new Set(["a", "b"]);

		const result = await scoreInBatches(
			"projects",
			2,
			async (_tried, failed) => [...flagged].filter((k) => !failed.includes(k)),
			async (keys) => {
				for (const k of keys) if (k !== "a") flagged.delete(k);
				return keys.filter((k) => k === "a");
			},
		);

		expect(result).toEqual({ scored: 1, failed: ["a"] });
	});
});

// What Prisma 7 throws through @prisma/adapter-pg, as scoreWrites.test.ts
// catches it from a real Postgres: the SQLSTATE is in the adapter's cause, and
// a 40001's message never names it.
const pgError = (code: string, prismaCode: string, message: string, originalMessage: string) =>
	Object.assign(new Error(`\nInvalid \`db.organizationTable.updateMany()\` invocation:\n\n${message}`), {
		name: "PrismaClientKnownRequestError",
		code: prismaCode,
		meta: {
			modelName: "OrganizationTable",
			driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: code, originalMessage } },
		},
	});

describe("withRetry", () => {
	it.each([
		["a deadlock", pgError("40P01", "P2039", "Database error. Code: `40P01`. Message: `deadlock detected`", "deadlock detected")],
		[
			"a serialization failure",
			pgError(
				"40001",
				"P2034",
				"Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
				"could not serialize access due to concurrent update",
			),
		],
	])("retries %s", async (_name, error) => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let calls = 0;
		const run = withRetry(async () => {
			if (++calls === 1) throw error;
			return "scored";
		}, "score a-1");
		await vi.runAllTimersAsync();
		await expect(run).resolves.toBe("scored");
		expect(calls).toBe(2);
	});

	it("never retries a real error", async () => {
		let calls = 0;
		const unique = pgError("23505", "P2002", "Unique constraint failed on the fields: (`projectKey`)", "duplicate key value");
		await expect(
			withRetry(async () => {
				calls++;
				throw unique;
			}, "score a-1"),
		).rejects.toBe(unique);
		expect(calls).toBe(1);
	});
});
