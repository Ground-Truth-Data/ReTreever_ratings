import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The scorers' parent is ReTreever, beside this repo in the workspace and in burnerReTreever.
export default defineConfig({
	// Never the dev server's `node_modules/.vite`: a test run would wipe optimized deps from under it.
	cacheDir: "node_modules/.vite-unit",
	resolve: {
		// Mirrors ReTreever/vitest.config.ts, same order: this repo's entry before the bare `$parent`, or it swallows it.
		alias: {
			"$parent/siblings/ReTreever_ratings": r("."),
			"$parent/siblings": r(".."),
			$parent: r("../ReTreever"),
		},
	},
	test: {
		silent: "passed-only",
		fsModuleCache: false,
		include: ["*.test.ts"],
		environment: "node",
		clearMocks: true,
		testTimeout: 20000,
		hookTimeout: 20000,
		// Builds the pglite data directory once, before every PGlite file's worker finds it missing at the same moment.
		globalSetup: [r("../ReTreever/tests/pglite/pgliteDb.ts")],
	},
});
