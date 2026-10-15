/**
 * Scoped auth-gateway clients.
 *
 * A holder of the gateway token may call every served model, and recovery may
 * serve it from any broker credential. A scoped client authenticates with its
 * own bearer, configured only as a SHA-256 digest, and is limited to:
 *
 * - `models`: the served models it may call, as exact `provider/id` grants or
 *   `provider/*`. Absent allows every served model; `[]` allows none.
 * - `accounts`: per provider, the broker OAuth accounts (identity keys, as in
 *   account pools) its requests may use. A listed provider never falls back to
 *   a sibling account or an API key; an empty list allows no account.
 *
 * Account binding reuses `AuthStorage.sessions.restrict`: a client's credential
 * lookups for a bound provider all resolve under one session id of its own,
 * restricted before the client's token is admitted. Replacing the table
 * restricts that session again in place and never lifts it, so a retry still
 * in flight never resolves unrestricted, and the client's conversations share
 * that session's account pin.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionsApi } from "../auth/types";
import type { Api, Model } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";

/** One scoped client. */
export interface AuthGatewayClient {
	/** Operator-chosen name, logged with the client's requests. */
	name: string;
	/** Hex SHA-256 digest of the client's bearer token. */
	tokenSha256: string;
	/** `provider/id` or `provider/*` grants; absent allows every served model, `[]` none. */
	models?: readonly string[];
	/** Provider id → OAuth identity keys the client's requests to that provider may use. */
	accounts?: Readonly<Record<string, readonly string[]>>;
}

/** An admitted scoped client, as the gateway's routes see it. */
export interface AuthGatewayClientScope {
	readonly name: string;
	/** False when the client may call every served model. */
	readonly limitsModels: boolean;
	/** Whether the client may call `model`. */
	allows(model: Model<Api>): boolean;
	/**
	 * Session id the client's credential lookups for `provider` resolve under:
	 * its own restricted session when `accounts` lists the provider, otherwise
	 * the request's `sessionId`.
	 */
	credentialSessionId(provider: string, sessionId: string): string;
}

const CLIENT_FIELDS: Record<string, true> = { tokenSha256: true, models: true, accounts: true };
const SHA256_HEX = /^[0-9a-f]{64}$/i;
// C0 controls and DEL: a name is logged verbatim.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function invalid(where: string, problem: string): Error {
	return new Error(`Invalid auth-gateway clients: ${where}: ${problem}`);
}

/**
 * Parse a clients file: a JSON object mapping each client name to
 * `{ tokenSha256, models?, accounts? }`. Any malformed entry or unknown field
 * rejects the whole file, since a misspelled `models` would otherwise allow
 * every model. Errors name the offending field, never its value.
 */
export function parseAuthGatewayClients(text: string): AuthGatewayClient[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid auth-gateway clients: not valid JSON");
	}
	if (!isRecord(value)) {
		throw new Error("Invalid auth-gateway clients: expected an object mapping each client name to its entry");
	}
	const clients: AuthGatewayClient[] = [];
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) throw invalid(name, "expected an object");
		for (const field of Object.keys(entry)) {
			if (!Object.hasOwn(CLIENT_FIELDS, field)) throw invalid(name, `unknown field "${field}"`);
		}
		const { tokenSha256, models, accounts } = entry;
		if (typeof tokenSha256 !== "string") throw invalid(`${name}.tokenSha256`, "expected a hex SHA-256 digest");
		const client: AuthGatewayClient = { name, tokenSha256 };
		if (models !== undefined) {
			if (!Array.isArray(models) || !models.every((grant): grant is string => typeof grant === "string")) {
				throw invalid(`${name}.models`, 'expected a list of "provider/id" or "provider/*" grants');
			}
			client.models = models;
		}
		if (accounts !== undefined) {
			if (!isRecord(accounts))
				throw invalid(`${name}.accounts`, "expected an object mapping provider to identity keys");
			// Null prototype: a provider named `__proto__` stays an own entry.
			const pools: Record<string, readonly string[]> = Object.create(null);
			for (const [provider, keys] of Object.entries(accounts)) {
				if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) {
					throw invalid(`${name}.accounts.${provider}`, "expected a list of OAuth identity keys");
				}
				pools[provider] = keys;
			}
			client.accounts = pools;
		}
		clients.push(client);
	}
	// Validate every entry here too, so a bad file fails where it is read.
	compileClients(clients, "");
	return clients;
}

/** Hex SHA-256 digest of a bearer token, as `tokenSha256` records it. */
export function hashAuthGatewayToken(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** A validated client: its model grants compiled, its accounts ready to restrict. */
class ClientScope implements AuthGatewayClientScope {
	readonly name: string;
	readonly tokenSha256: string;
	readonly limitsModels: boolean;
	/** Exact `provider/id` grants. */
	readonly #models = new Set<string>();
	/** Providers granted with `provider/*`. */
	readonly #providers = new Set<string>();
	readonly #accounts = new Map<string, readonly string[]>();
	readonly #sessionId: string;

	constructor(client: AuthGatewayClient, salt: string) {
		const { name } = client;
		if (typeof name !== "string" || name.length === 0 || CONTROL_CHARACTER.test(name)) {
			throw new Error("Invalid auth-gateway clients: a client name must be non-empty text");
		}
		if (!SHA256_HEX.test(client.tokenSha256)) throw invalid(`${name}.tokenSha256`, "expected 64 hex digits");
		this.name = name;
		this.tokenSha256 = client.tokenSha256.toLowerCase();
		this.limitsModels = client.models !== undefined;
		for (const grant of client.models ?? []) {
			const slash = grant.indexOf("/");
			const provider = grant.slice(0, slash);
			const id = grant.slice(slash + 1);
			if (slash <= 0 || id.length === 0 || grant.trim() !== grant || (id.includes("*") && id !== "*")) {
				throw invalid(`${name}.models`, 'each grant must be "provider/id" or "provider/*"');
			}
			if (id === "*") this.#providers.add(provider);
			else this.#models.add(grant);
		}
		for (const [provider, keys] of Object.entries(client.accounts ?? {})) {
			if (provider.length === 0 || !keys.every(key => key.length > 0 && key.trim() === key)) {
				throw invalid(`${name}.accounts`, 'expected identity keys such as "email:you@example.com|org:<org-id>"');
			}
			this.#accounts.set(provider, keys);
		}
		this.#sessionId = deterministicUuid(`auth-gateway client\u0000${salt}\u0000${name}`);
	}

	allows(model: Model<Api>): boolean {
		return (
			!this.limitsModels || this.#providers.has(model.provider) || this.#models.has(`${model.provider}/${model.id}`)
		);
	}

	credentialSessionId(provider: string, sessionId: string): string {
		return this.#accounts.has(provider) ? this.#sessionId : sessionId;
	}

	/** Restrict this client's session to its accounts, replacing any earlier restriction of the same name. */
	restrict(sessions: Pick<SessionsApi, "restrict">): void {
		for (const [provider, keys] of this.#accounts) sessions.restrict(provider, this.#sessionId, keys);
	}
}

/** Validate `clients` as one table and compile it, keyed by token digest. */
function compileClients(clients: readonly AuthGatewayClient[], salt: string): Map<string, ClientScope> {
	const compiled = new Map<string, ClientScope>();
	const names = new Set<string>();
	for (const client of clients) {
		const scope = new ClientScope(client, salt);
		if (names.has(scope.name)) throw invalid(scope.name, "duplicate client name");
		if (compiled.has(scope.tokenSha256)) throw invalid(scope.name, "another client has the same tokenSha256");
		names.add(scope.name);
		compiled.set(scope.tokenSha256, scope);
	}
	return compiled;
}

/**
 * The scoped clients one gateway admits, looked up by the digest of the
 * presented bearer.
 */
export class AuthGatewayClientTable {
	readonly #sessions: Pick<SessionsApi, "restrict">;
	/** Digests of the gateway's own tokens, which no client may claim. */
	readonly #reserved: ReadonlySet<string>;
	/** Keeps two gateways over one `AuthStorage` from sharing a client's session. */
	readonly #salt = crypto.randomUUID();
	#byDigest = new Map<string, ClientScope>();

	constructor(sessions: Pick<SessionsApi, "restrict">, gatewayTokens: Iterable<string>) {
		this.#sessions = sessions;
		this.#reserved = new Set(Array.from(gatewayTokens, hashAuthGatewayToken));
	}

	/**
	 * Replace the admitted clients. An invalid table throws and changes
	 * nothing. Each client's accounts are restricted before its token is
	 * admitted; a removed client's session keeps its last restriction.
	 */
	set(clients: readonly AuthGatewayClient[]): void {
		const next = compileClients(clients, this.#salt);
		for (const scope of next.values()) {
			if (this.#reserved.has(scope.tokenSha256)) {
				throw invalid(scope.name, "tokenSha256 is the gateway token's digest; give the client its own token");
			}
		}
		for (const scope of next.values()) scope.restrict(this.#sessions);
		this.#byDigest = next;
	}

	/** The client `token` authenticates, if any. */
	authenticate(token: string): AuthGatewayClientScope | undefined {
		return this.#byDigest.get(hashAuthGatewayToken(token));
	}
}
