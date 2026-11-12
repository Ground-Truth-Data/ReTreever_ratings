import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { RATING_STATE_FLOORS, RATING_STATES } from "$parent/siblings/ReTreever_who_what/lib/rating/ratingState";
import { SCORE_MATRIX } from "./scoreMatrix";

// The README is the method an outsider reads: its weights and its state bands
// must be the code's, or the published method says something the code does not.

const readme = fs.readFileSync(new URL("./README.md", import.meta.url), "utf8");

/** The rows of the markdown table under `## heading` or `### heading`, cells trimmed, header and rule dropped. */
function tableUnder(heading: string): string[][] {
	const at = readme.search(new RegExp(`^#{2,3} ${heading}$`, "m"));
	expect(at, `README has no "${heading}" section`).toBeGreaterThanOrEqual(0);
	const lines = readme.slice(at).split("\n");
	const start = lines.findIndex((l) => l.startsWith("|"));
	const rows: string[][] = [];
	for (const line of lines.slice(start)) {
		if (!line.startsWith("|")) break;
		rows.push(line.split("|").slice(1, -1).map((c) => c.trim()));
	}
	return rows.slice(2);
}

describe("README matches the code", () => {
	it("lists every weight in SCORE_MATRIX, and no other", () => {
		const weights = Object.fromEntries(tableUnder("The weights").map(([field, points]) => [field.replaceAll("`", ""), Number(points)]));
		const matrix = Object.fromEntries(Object.entries(SCORE_MATRIX).map(([field, { points }]) => [field, points]));
		expect(weights).toEqual(matrix);
	});

	it("states the bands ratingState draws, in order", () => {
		const rows = tableUnder("The state words").map(([state, range]) => ({
			state: state.replaceAll("*", "").toLowerCase(),
			floor: Number(/^\d+/.exec(range)?.[0]),
		}));
		expect(rows).toEqual(RATING_STATES.map((state) => ({ state, floor: RATING_STATE_FLOORS[state] })));
		const tops = rows.slice(1).map((r) => r.floor);
		tableUnder("The state words").slice(0, -1).forEach(([, range], i) => {
			expect(range).toBe(`${rows[i].floor} to below ${tops[i]}`);
		});
		expect(tableUnder("The state words").at(-1)?.[1]).toBe(`${rows.at(-1)?.floor} to 100`);
	});
});
