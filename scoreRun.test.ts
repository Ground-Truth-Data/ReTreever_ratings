import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreInBatches } from "./scoreRun";

afterEach(() => vi.restoreAllMocks());

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
