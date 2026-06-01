import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { server } from "../src/server.js";
import {
	initDb,
	registerRepository,
	saveCachedPackage,
} from "../src/database.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("Registry Upstream Package Version Caching", () => {
	const owner = "cacheowner";
	const repo = "cache-repo";
	const token = "pb_reg_cache_test_token_999";

	beforeEach(async () => {
		process.env.DATABASE_FILE = "packablock_test_cache.sqlite";
		initDb();

		// Register repository to have a valid token
		registerRepository(owner, repo, token);
	});

	afterEach(async () => {
		try {
			await fs.unlink(path.join(process.cwd(), "packablock_test_cache.sqlite"));
		} catch (e) {}
	});

	it("should retrieve a package version from the cache when it is within TTL", async () => {
		// 1. Seed the cache database manually with a mock package version
		const pkgName = "super-cool-test-package";
		const mockVersion = "9.9.9-mocked-caching";
		saveCachedPackage(pkgName, mockVersion);

		// 2. Query `/api/v1/packages/latest` for this package
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/packages/latest",
			headers: {
				"content-type": "application/json",
				"x-repo-token": token,
			},
			body: {
				packages: [pkgName],
			},
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		expect(data.packages[pkgName]).toBe(mockVersion); // Confirms cache hit
	});

	it("should fall back to fetching (or ignore) when cache record has expired (TTL boundary check)", async () => {
		// 1. Seed the cache with an expired date
		const pkgName = "expired-test-package";
		const mockVersion = "0.0.1-expired";

		// Set cache TTL to 1ms to force expiration
		process.env.PACKAGE_CACHE_TTL_MS = "1";
		saveCachedPackage(pkgName, mockVersion);

		// Sleep for 5ms to guarantee expiration
		await new Promise((resolve) => setTimeout(resolve, 5));

		// 2. Query `/api/v1/packages/latest`
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/packages/latest",
			headers: {
				"content-type": "application/json",
				"x-repo-token": token,
			},
			body: {
				packages: [pkgName],
			},
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		// Since it expired, it tried to fetch from NPM registry (which fails/ignores for non-existent mock package)
		// Hence, the returned packages won't contain the expired mock version
		expect(data.packages[pkgName]).toBeUndefined();
	});
});
