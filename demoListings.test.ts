import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgliteDb, type TestDb } from "$parent/tests/pglite/pgliteDb";
import { scoreOneOrg } from "./orgScore";
import { orgSubtree } from "./subtree";

// A demo listing is hidden from the site by its name, so no score counts it: not a demo child under a real
// parent, not a demo-named project a real org holds a role on. Keys and names as dev holds them.

let t: TestDb;
beforeAll(async () => {
	t = await pgliteDb();
});
afterAll(() => t.close());
beforeEach(async () => {
	await t.reset();
	await t.prisma.stakeholderCategoryTable.createMany({ data: [{ stakeholderCategoryId: "developer_ish", stakeholderCategoryName: "Developer" }] });
});

const RA = "p-rainforest%20alliance";
const RA_DEMO = "e-%5Bdemo%5D%20rainforest%20alliance";

const org = (organizationKey: string, organizationName: string, organizationParentKey: string | null = null) =>
	t.prisma.organizationTable.create({ data: { organizationKey, organizationName, organizationParentKey } });

async function project(projectKey: string, projectName: string, organizationKey: string, scoreProject: number) {
	await t.prisma.projectTable.create({ data: { projectKey, projectName, scoreProject, scorePointsScored: 1, scorePointsAvailable: 1 } });
	await t.prisma.stakeholderTable.create({
		data: { stakeholderKey: `s-${projectKey}-${organizationKey}`, organizationKey, projectKey, parentKey: projectKey, parentTable: "projectTable", stakeholderCategory: "developer_ish" },
	});
}

const inputsOf = async (organizationKey: string) =>
	(await t.prisma.orgScoreInputTable.findMany({ where: { organizationKey }, orderBy: { projectKey: "asc" } })).map((i) => i.projectKey);

const preClaim = async (organizationKey: string) =>
	Number((await t.prisma.organizationTable.findUniqueOrThrow({ where: { organizationKey } })).scoreOrgPreClaim);

describe("no score counts a demo listing", () => {
	it("Rainforest Alliance's subtree leaves out its demo child, and so does its score", async () => {
		await org(RA, "Rainforest Alliance");
		await org("e-rainforest%20alliance", "Rainforest Alliance", RA);
		await org(RA_DEMO, "[Demo] Rainforest Alliance", RA);
		await project("e-real", "Cocoa landscapes", "e-rainforest%20alliance", 0.5);
		await project("e-q4d7myr085ya6kzx", "Sui River", RA_DEMO, 1);

		expect(await orgSubtree(t.prisma, RA)).toEqual([RA, "e-rainforest%20alliance"]);
		await scoreOneOrg(t.prisma, RA, "run-1");
		expect(await inputsOf(RA)).toEqual(["e-real"]);
		expect(await preClaim(RA)).toBe(0.5);
	});

	it("explorer.land's score leaves out a demo-named project it holds a role on", async () => {
		await org("e-e", "explorer.land");
		await project("e-eg9mb368bqy8z7l6", "[Demo] Chapada dos Veadeiros", "e-e", 1);
		await project("e-lmedq3qe58397va4", "Coffee Plantation implementing Agroforestry in Bolivia (Demo)", "e-e", 1);
		await project("e-real", "Ajimaka Agroforestry Demonstration Plots", "e-e", 0.25);

		await scoreOneOrg(t.prisma, "e-e", "run-1");
		expect(await inputsOf("e-e")).toEqual(["e-real"]);
		expect(await preClaim("e-e")).toBe(0.25);
	});
});
