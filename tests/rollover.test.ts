import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { server } from "../src/server.js";
import {
	initDb,
	registerRepository,
	getLog,
	getArchivedLogs,
} from "../src/database.js";
import { sha256, deterministicMetaHash } from "../src/verify.js";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

describe("Registry Log Rollover and Archiving Endpoints", () => {
	const owner = "rolloverowner";
	const repo = "rollover-repo";
	const token = "pb_reg_rollover_test_token_123";
	let repoId = 0;

	// Cryptographic mock block helper
	function createMockBlock(
		index: number,
		dataText: string,
		prevHash: string,
	): { blockText: string; metaHash: string } {
		const cleanData = `${dataText.trim()}\n`;
		const dataHash = sha256(cleanData.trim());

		const meta: any = {
			version: "1.0.0",
			block_index: index,
			timestamp: new Date().toISOString(),
			hashing_strategy: "raw",
			data_hash: dataHash,
			prev_meta_hash: prevHash,
		};

		const metaHash = deterministicMetaHash(meta);
		meta.meta_hash = metaHash;

		const blockText = `${cleanData}---\n${YAML.stringify({ "$yaml-chain-meta": meta }).trim()}\n`;
		return { blockText, metaHash };
	}

	beforeEach(async () => {
		process.env.DATABASE_FILE = "packablock_test_rollover.sqlite";
		initDb();

		// Register repository and push initial active chain log
		const repoRecord = registerRepository(owner, repo, token);
		repoId = repoRecord.id;
	});

	afterEach(async () => {
		try {
			await fs.unlink(
				path.join(process.cwd(), "packablock_test_rollover.sqlite"),
			);
		} catch (e) {}
	});

	it("should successfully coordinate rollover, archive the active log, and initialize a new active log", async () => {
		// 1. First push a cryptographically valid active log to the server
		const { blockText: mockOldChain, metaHash: oldMetaHash } = createMockBlock(
			0,
			'message: "Genesis"',
			"0000000000000000000000000000000000000000000000000000000000000000",
		);

		let res = await server.inject({
			method: "POST",
			url: "/api/v1/log/push",
			headers: {
				"content-type": "text/yaml",
				"x-repo-token": token,
				"x-target-repo": `${owner}/${repo}`,
			},
			body: mockOldChain,
		});
		expect(res.statusCode).toBe(200);

		// 2. Perform key rollover with a new cryptographically linked genesis block
		const { blockText: mockNewRolloverGenesis, metaHash: newMetaHash } =
			createMockBlock(
				0,
				`genesis_rollover: true\nrotated_at: "${new Date().toISOString()}"\nprevious_chain_hash: "${oldMetaHash}"`,
				oldMetaHash,
			);

		res = await server.inject({
			method: "POST",
			url: `/api/v1/repo/${owner}/${repo}/rollover`,
			headers: {
				"content-type": "application/json",
				"x-repo-token": token,
			},
			body: {
				previous_chain_hash: oldMetaHash,
				new_genesis_block: mockNewRolloverGenesis,
			},
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		expect(data.archivedBlockCount).toBe(1);
		expect(data.archivedChainHash).toBe(oldMetaHash);
		expect(data.newGenesisHash).toBe(newMetaHash);

		// 3. Assert active log is now the new genesis block
		const activeLog = getLog(repoId);
		expect(activeLog).not.toBeNull();
		expect(activeLog?.block_count).toBe(1);
		expect(activeLog?.last_block_hash).toBe(newMetaHash);
		expect(activeLog?.chain_content).toBe(mockNewRolloverGenesis);

		// 4. Assert archived log exists and holds the old chain content
		const archives = getArchivedLogs(repoId);
		expect(archives).toHaveLength(1);
		expect(archives[0]!.epoch_index).toBe(0);
		expect(archives[0]!.block_count).toBe(1);
		expect(archives[0]!.last_block_hash).toBe(oldMetaHash);
		expect(archives[0]!.chain_content).toBe(mockOldChain);

		// 5. Test retrieve /archive endpoint
		const archiveRes = await server.inject({
			method: "GET",
			url: `/api/v1/repo/${owner}/${repo}/archive`,
		});
		expect(archiveRes.statusCode).toBe(200);
		const archiveData = JSON.parse(archiveRes.body);
		expect(archiveData.success).toBe(true);
		expect(archiveData.archives).toHaveLength(1);
		expect(archiveData.archives[0]!.epochIndex).toBe(0);
		expect(archiveData.archives[0]!.lastBlockHash).toBe(oldMetaHash);
	});

	it("should reject rollover if the previous chain hash mismatch the anchored hash", async () => {
		// First push active log
		const { blockText: mockOldChain, metaHash: oldMetaHash } = createMockBlock(
			0,
			'message: "Genesis"',
			"0000000000000000000000000000000000000000000000000000000000000000",
		);

		await server.inject({
			method: "POST",
			url: "/api/v1/log/push",
			headers: {
				"content-type": "text/yaml",
				"x-repo-token": token,
				"x-target-repo": `${owner}/${repo}`,
			},
			body: mockOldChain,
		});

		// Rollover with mismatched hash in rollover block
		const { blockText: mockNewRolloverGenesis } = createMockBlock(
			0,
			"genesis_rollover: true",
			"mismatched_hash",
		);

		const res = await server.inject({
			method: "POST",
			url: `/api/v1/repo/${owner}/${repo}/rollover`,
			headers: {
				"content-type": "application/json",
				"x-repo-token": token,
			},
			body: {
				previous_chain_hash: "wrong_previous_hash",
				new_genesis_block: mockNewRolloverGenesis,
			},
		});

		expect(res.statusCode).toBe(409); // Conflict
		const data = JSON.parse(res.body);
		expect(data.error).toBe("Conflict");
	});
});
