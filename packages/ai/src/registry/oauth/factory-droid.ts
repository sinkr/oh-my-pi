import { factoryDroidApiBaseUrl, resolveFactoryDroidInferenceRegion } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import * as AIError from "../../error";
import { isRecord } from "../../utils";
import type { AfterExchangeHook, ExchangeContext } from "../hooks/types";
import { refreshOAuthToken } from "./index";
import type { OAuthCredentials } from "./types";

/**
 * WorkOS organization a bearer without an org claim belongs to, from `/api/cli/org`.
 * These ids scope the WorkOS refresh grant; they are never Factory org ids.
 */
async function lookupWorkOSOrganization(
	credentials: OAuthCredentials,
	region: string | undefined,
	context: ExchangeContext,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(region)}/api/cli/org`, {
			headers: { Authorization: `Bearer ${credentials.access}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.workosOrgIds)) return undefined;
		const [orgId] = body.workosOrgIds;
		return typeof orgId === "string" && orgId ? orgId : undefined;
	} catch {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		return undefined;
	}
}

/** Resolve canonical Factory identity; residency chooses the host, inference scope chooses eligible routes. */
export const attachFactoryDroidRegion: AfterExchangeHook = async (credentials, context) => {
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	if (!isRecord(context.raw) || typeof context.raw.refresh_token !== "string" || !credentials.refresh) {
		throw new AIError.OAuthError("Factory token response missing refresh token", { kind: "validation" });
	}
	const selectedOrg =
		typeof context.raw.organization_id === "string"
			? context.raw.organization_id
			: context.stored?.activeOrganizationId;
	// The token's Factory org claim belongs to the new bearer: a different
	// claim is an org change even when the WorkOS selection is unchanged.
	const factoryOrgChanged = Boolean(
		credentials.orgId && context.stored?.orgId && credentials.orgId !== context.stored.orgId,
	);
	const sameOrg =
		!factoryOrgChanged &&
		(!selectedOrg || !context.stored?.activeOrganizationId || selectedOrg === context.stored.activeOrganizationId);
	const identity = {
		...credentials,
		activeOrganizationId: selectedOrg,
		orgId: credentials.orgId ?? (sameOrg ? context.stored?.orgId : undefined),
		region: sameOrg ? context.stored?.region : undefined,
		inferenceRegion: sameOrg ? context.stored?.inferenceRegion : undefined,
	};
	const timeout = AbortSignal.timeout(15_000);
	const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
	// Factory rejects a bearer without an org claim, so scope the grant to the
	// account's WorkOS organization first. The refresh re-enters this hook with
	// that organization selected, which ends the lookup.
	if (!credentials.orgId) {
		const workosOrg = await lookupWorkOSOrganization(credentials, identity.region, context, signal);
		if (workosOrg && workosOrg !== context.stored?.activeOrganizationId) {
			let scoped: OAuthCredentials | undefined;
			try {
				scoped = await refreshOAuthToken(
					"factory-droid",
					{ ...identity, activeOrganizationId: workosOrg },
					context.signal,
				);
			} catch {
				// Fall through: the identity check below reports why the bearer is unusable.
				if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
			}
			if (scoped) {
				if (context.phase === "login" && !scoped.orgId) {
					throw new AIError.OAuthError("Factory login did not resolve an organization", {
						kind: "validation",
						provider: context.provider,
					});
				}
				return scoped;
			}
		}
	}
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(identity.region)}/api/cli/whoami`, {
			headers: {
				Authorization: `Bearer ${credentials.access}`,
				Accept: "application/json",
				...(identity.orgId ? { "X-Factory-Org-Id": identity.orgId } : {}),
			},
			signal,
		});
		if (!response.ok && context.phase === "login") {
			throw new AIError.OAuthError(`Factory identity check failed (${response.status}): ${await response.text()}`, {
				kind: "validation",
				provider: context.provider,
				status: response.status,
			});
		}
		if (response.ok) {
			const body: unknown = await response.json();
			if (isRecord(body)) {
				const orgId = typeof body.orgId === "string" && body.orgId ? body.orgId : identity.orgId;
				if (context.phase === "login" && !orgId) {
					throw new AIError.OAuthError("Factory login did not resolve an organization", {
						kind: "validation",
						provider: context.provider,
					});
				}
				// A different organization must not inherit the stored scope.
				const carried = !orgId || !identity.orgId || orgId === identity.orgId ? identity : undefined;
				const region = body.region === "eu" || body.region === "global" ? body.region : carried?.region;
				const inferenceRegion =
					body.inferenceRegion === "global" || body.inferenceRegion === "eu" || body.inferenceRegion === "us"
						? body.inferenceRegion
						: resolveFactoryDroidInferenceRegion({ region, inferenceRegion: carried?.inferenceRegion });
				return { ...identity, orgId, region, inferenceRegion };
			}
		}
	} catch (error) {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		if (context.phase === "login") throw error;
		// Preserve identity only when this is still the same selected organization.
	}
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	if (context.phase === "login" && !identity.orgId) {
		throw new AIError.OAuthError("Factory login did not resolve an organization", {
			kind: "validation",
			provider: context.provider,
		});
	}
	return identity;
};
