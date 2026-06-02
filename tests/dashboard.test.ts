import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { server } from "../src/server.ts";
import { initDb } from "../src/database.ts";
import {
	sha256,
	deterministicMetaHash,
	GENESIS_PREV_HASH,
} from "../src/verify.ts";
import YAML from "yaml";
import fs from "node:fs";
import path from "node:path";

const TEST_DB = "packablock_test_dashboard.sqlite";
const ADMIN_TOKEN = "admin_secret_token_1234";

function createValidChainPair(
	index: number,
	prevMetaHash: string,
	dataObj: any,
) {
	const dataDocStr = YAML.stringify(dataObj);
	const dataHash = sha256(dataDocStr.trim());

	const metaObjWithoutHash = {
		version: "1.0.0",
		block_index: index,
		timestamp: new Date().toISOString(),
		hashing_strategy: "raw" as const,
		data_hash: dataHash,
		prev_meta_hash: prevMetaHash,
	};

	const metaHash = deterministicMetaHash(metaObjWithoutHash);
	const metaObj = {
		...metaObjWithoutHash,
		meta_hash: metaHash,
	};

	const metaDocStr = YAML.stringify({ "$yaml-chain-meta": metaObj });

	return {
		dataHash,
		metaHash,
		chainFragment: `---\n${dataDocStr}---\n${metaDocStr}`,
	};
}

beforeAll(() => {
	process.env.DATABASE_FILE = TEST_DB;
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;

	const dbFile = path.join(process.cwd(), TEST_DB);
	if (fs.existsSync(dbFile)) {
		try {
			fs.unlinkSync(dbFile);
		} catch (e) {}
	}
	initDb();
});

afterAll(() => {
	const dbFile = path.join(process.cwd(), TEST_DB);
	if (fs.existsSync(dbFile)) {
		try {
			fs.unlinkSync(dbFile);
		} catch (e) {}
	}
});

describe("Registry Internal Management & Monitoring API Endpoints", () => {
	let repoId: number;
	let registrationToken: string;
	const INTERNAL_TOKEN = "internal_secret_token_1234";

	beforeAll(() => {
		process.env.INTERNAL_REGISTRY_TOKEN = INTERNAL_TOKEN;
	});

	it("should successfully register a standard account for testing", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "dashowner",
				repo: "dash-repo",
				isPremium: false,
			},
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		registrationToken = data.registrationToken;
		expect(registrationToken).toBeDefined();
	});

	it("should reject internal API calls without valid internal token header", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/v1/internal/system/status",
		});
		expect(res.statusCode).toBe(401);
		const data = JSON.parse(res.body);
		expect(data.error).toBe("Unauthorized");
	});

	it("should reject internal API calls with incorrect internal token header", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/v1/internal/system/status",
			headers: { "X-Packablock-Internal-Token": "forged_token" },
		});
		expect(res.statusCode).toBe(401);
	});

	it("should successfully retrieve system status with correct internal token header", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/v1/internal/system/status",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		expect(data.status).toBe("Secured");
		expect(data.reposCount).toBe(1);
	});

	it("should successfully list registered repositories with correct internal token", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/v1/internal/repos",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		expect(data.repos.length).toBe(1);
		expect(data.repos[0].owner).toBe("dashowner");
		expect(data.repos[0].repo).toBe("dash-repo");
		repoId = data.repos[0].id;
	});

	it("should toggle premium access tier via internal API", async () => {
		const toggleRes = await server.inject({
			method: "POST",
			url: `/api/v1/internal/repo/${repoId}/toggle-premium`,
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		expect(toggleRes.statusCode).toBe(200);

		// Verify change
		const checkRes = await server.inject({
			method: "GET",
			url: "/api/v1/internal/repos",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		const checkData = JSON.parse(checkRes.body);
		expect(checkData.repos[0].is_premium).toBe(1);
	});

	it("should successfully retrieve chain tree for a repository", async () => {
		// First push a valid block to have some chain data
		const block = createValidChainPair(0, GENESIS_PREV_HASH, {
			message: "Initial block",
		});
		const mockChain = block.chainFragment + "\n";

		const pushRes = await server.inject({
			method: "POST",
			url: "/api/v1/log/push",
			headers: {
				"Content-Type": "text/yaml",
				"X-Repo-Token": registrationToken,
			},
			payload: mockChain,
		});

		expect(pushRes.statusCode).toBe(200);

		// Now fetch visual chain tree
		const treeRes = await server.inject({
			method: "GET",
			url: `/api/v1/internal/chain/tree?id=${repoId}`,
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});

		expect(treeRes.statusCode).toBe(200);
		const treeData = JSON.parse(treeRes.body);
		expect(treeData.success).toBe(true);
		expect(treeData.blockCount).toBe(1);
		expect(treeData.tree.children.length).toBe(1);
		expect(treeData.tree.children[0].meta_hash).toBe(block.metaHash);
	});

	it("should revoke repository registration token via internal API", async () => {
		const revokeRes = await server.inject({
			method: "POST",
			url: `/api/v1/internal/repo/${repoId}/revoke`,
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		expect(revokeRes.statusCode).toBe(200);

		// Verify token was revoked (starts with pb_revoked_)
		const checkRes = await server.inject({
			method: "GET",
			url: "/api/v1/internal/repos",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		const checkData = JSON.parse(checkRes.body);
		expect(
			checkData.repos[0].registration_token.startsWith("pb_revoked_"),
		).toBe(true);
	});

	it("should register a premium pending repository and purge it as stale metadata", async () => {
		// Register a premium pending repo
		const regRes = await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "staleowner",
				repo: "stale-repo",
				isPremium: true,
			},
		});

		expect(regRes.statusCode).toBe(200);
		const regData = JSON.parse(regRes.body);
		expect(regData.verificationStatus).toBe("pending");

		// List repos to verify it is present
		const beforeListRes = await server.inject({
			method: "GET",
			url: "/api/v1/internal/repos",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		const beforeListData = JSON.parse(beforeListRes.body);
		expect(beforeListData.repos.length).toBe(2);

		// Call purge-stale endpoint
		const purgeRes = await server.inject({
			method: "POST",
			url: "/api/v1/internal/purge-stale",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});

		expect(purgeRes.statusCode).toBe(200);
		const purgeData = JSON.parse(purgeRes.body);
		expect(purgeData.success).toBe(true);
		expect(purgeData.purgedCount).toBe(1);

		// List repos to verify it has been successfully garbage collected
		const afterListRes = await server.inject({
			method: "GET",
			url: "/api/v1/internal/repos",
			headers: { "X-Packablock-Internal-Token": INTERNAL_TOKEN },
		});
		const afterListData = JSON.parse(afterListRes.body);
		expect(afterListData.repos.length).toBe(1);
	});
});
