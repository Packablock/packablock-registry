import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { server } from "../src/server.ts";
import { initDb } from "../src/database.ts";
import fs from "node:fs";
import path from "node:path";

const TEST_DB = "packablock_test_acme.sqlite";

beforeAll(() => {
	// Set isolated test database environment variable
	process.env.DATABASE_FILE = TEST_DB;

	// Ensure any stale database file is removed
	const dbFile = path.join(process.cwd(), TEST_DB);
	if (fs.existsSync(dbFile)) {
		try {
			fs.unlinkSync(dbFile);
		} catch (e) {}
	}

	// Initialize database
	initDb();
});

afterAll(() => {
	// Teardown and clean up the test database file
	const dbFile = path.join(process.cwd(), TEST_DB);
	if (fs.existsSync(dbFile)) {
		try {
			fs.unlinkSync(dbFile);
		} catch (e) {}
	}
});

describe("Registry ACME Verification Challenge Endpoints", () => {
	it("should successfully register a standard (non-premium) account immediately", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "testowner",
				repo: "standard-repo",
				isPremium: false,
			},
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		expect(data.isPremium).toBe(false);
		expect(data.verificationStatus).toBe("none");
		expect(data.registrationToken).toBeDefined();
		expect(data.registrationToken.startsWith("pb_reg_")).toBe(true);
	});

	it("should successfully initiate premium pending registration and return a challenge nonce", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "testowner",
				repo: "premium-repo",
				isPremium: true,
			},
		});

		expect(res.statusCode).toBe(200);
		const data = JSON.parse(res.body);
		expect(data.success).toBe(true);
		expect(data.isPremium).toBe(true);
		expect(data.verificationStatus).toBe("pending");
		expect(data.challengeNonce).toBeDefined();
		expect(data.challengeNonce.startsWith("pb_nonce_")).toBe(true);
	});

	it("should reject verification requests on non-existent premium repositories", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/acme/verify",
			payload: {
				owner: "testowner",
				repo: "unknown-repo",
				verificationType: "github-api",
			},
		});

		expect(res.statusCode).toBe(404);
		const data = JSON.parse(res.body);
		expect(data.error).toBe("Not Found");
		expect(data.message).toContain("No pending premium registration found");
	});

	it("should reject verification with missing arguments", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/v1/acme/verify",
			payload: {
				owner: "testowner",
				verificationType: "github-api",
			},
		});

		expect(res.statusCode).toBe(400);
		const data = JSON.parse(res.body);
		expect(data.error).toBe("Bad Request");
	});

	it("should reject verification with unsupported verification types", async () => {
		// First, seed a premium pending record
		await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "testowner",
				repo: "invalid-type-repo",
				isPremium: true,
			},
		});

		const res = await server.inject({
			method: "POST",
			url: "/api/v1/acme/verify",
			payload: {
				owner: "testowner",
				repo: "invalid-type-repo",
				verificationType: "unsupported-verifier",
			},
		});

		expect(res.statusCode).toBe(400);
		const data = JSON.parse(res.body);
		expect(data.error).toBe("Bad Request");
		expect(data.message).toContain("Invalid verificationType");
	});

	it("should successfully verify premium pending account via mocked github-api pathway", async () => {
		// 1. Seed a premium pending record
		const registerRes = await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "testowner",
				repo: "premium-api-repo",
				isPremium: true,
			},
		});
		const registerData = JSON.parse(registerRes.body);
		expect(registerData.success).toBe(true);
		expect(registerData.challengeNonce).toBeDefined();

		// Set mock environment variable
		process.env.MOCK_GITHUB_API = "true";

		// 2. Request verification
		const verifyRes = await server.inject({
			method: "POST",
			url: "/api/v1/acme/verify",
			payload: {
				owner: "testowner",
				repo: "premium-api-repo",
				verificationType: "github-api",
			},
		});

		expect(verifyRes.statusCode).toBe(200);
		const verifyData = JSON.parse(verifyRes.body);
		expect(verifyData.success).toBe(true);
		expect(verifyData.verificationStatus).toBe("verified");
		expect(verifyData.registrationToken).toBeDefined();
		expect(verifyData.registrationToken.startsWith("pb_reg_")).toBe(true);

		// Clean up environment
		delete process.env.MOCK_GITHUB_API;
	});

	it("should successfully verify premium pending account via mocked github-attestation pathway", async () => {
		// 1. Seed a premium pending record
		const registerRes = await server.inject({
			method: "POST",
			url: "/api/v1/acme/new-account",
			payload: {
				owner: "testowner",
				repo: "premium-attestation-repo",
				isPremium: true,
			},
		});
		const registerData = JSON.parse(registerRes.body);
		expect(registerData.success).toBe(true);
		expect(registerData.challengeNonce).toBeDefined();

		// Set mock environment variable
		process.env.MOCK_GITHUB_API = "true";

		// 2. Request verification
		const verifyRes = await server.inject({
			method: "POST",
			url: "/api/v1/acme/verify",
			payload: {
				owner: "testowner",
				repo: "premium-attestation-repo",
				verificationType: "github-attestation",
				attestationBundle: { mock: "bundle_data" },
			},
		});

		expect(verifyRes.statusCode).toBe(200);
		const verifyData = JSON.parse(verifyRes.body);
		expect(verifyData.success).toBe(true);
		expect(verifyData.verificationStatus).toBe("verified");
		expect(verifyData.registrationToken).toBeDefined();
		expect(verifyData.registrationToken.startsWith("pb_reg_")).toBe(true);

		// Clean up environment
		delete process.env.MOCK_GITHUB_API;
	});
});
