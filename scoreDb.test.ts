import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

// A session-pooler client pins a Postgres backend: a --full run's ten left dev Central's gates without slots
// (23 Nov 2026). The run lock opens its own session; the scorer's pool needs none.
it("the scorer's pool is built from the transaction pooler alone", async () => {
	vi.stubEnv("GC_RT_supabase_dev_session", "");
	vi.stubEnv("GC_RT_supabase_dev_transaction", "postgresql://stub@127.0.0.1:1/stub");
	vi.resetModules();
	const { scoreDb } = await import("./scoreDb.ts");
	expect(() => scoreDb()).not.toThrow();
});
