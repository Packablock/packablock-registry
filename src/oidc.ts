import { createRemoteJWKSet, jwtVerify } from "jose";

// Establish the public GitHub JSON Web Key Set (JWKS) reference.
// The jose library automatically caches keys and fetches updates dynamically when needed.
const JWKS_URL = new URL(
	"https://token.actions.githubusercontent.com/.well-known/jwks",
);
const JWKS = createRemoteJWKSet(JWKS_URL);

export interface OidcVerificationResult {
	valid: boolean;
	reason?: string;
	payload?: any;
}

/**
 * Cryptographically verifies a GitHub Actions OIDC ID Token.
 * Matches the 'repository' claim against the expected registered repository path.
 *
 * @param token The raw GITHUB_OIDC_TOKEN JWT string
 * @param expectedRepo The expected repository path in "owner/repo" format (e.g. "packablock/packablock-client")
 */
export async function verifyGithubOidcToken(
	token: string,
	expectedRepo: string,
): Promise<OidcVerificationResult> {
	try {
		// Cryptographically verify signature, expiry, and issuer
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: "https://token.actions.githubusercontent.com",
		});

		// Ensure the token corresponds to the expected repository
		const repository = payload.repository as string;
		if (!repository) {
			return {
				valid: false,
				reason: 'OIDC token is missing the "repository" claim.',
			};
		}

		if (repository.toLowerCase() !== expectedRepo.toLowerCase()) {
			return {
				valid: false,
				reason: `Repository mismatch in OIDC claim: expected "${expectedRepo}", but token was issued for "${repository}".`,
			};
		}

		return {
			valid: true,
			payload,
		};
	} catch (err: any) {
		return {
			valid: false,
			reason: `JWT verification failed: ${err.message}`,
		};
	}
}
