/**
 * The control plane's client for the tunnel gateway's control API.
 *
 * Registering a route with the gateway is the moment a published service
 * becomes reachable, so this is where "the control plane is authoritative" and
 * "the gateway carries only what it was told to" meet. The gateway is the
 * enforcement point; this client is the instruction.
 *
 * The wire contract is `services/tunnel-gateway/testdata/gateway-api/`, a
 * corpus both this client and the Go handler run. It is not generated from
 * `packages/protocol` yet: `docs/DEVELOPMENT.md` section 3 says API schemas
 * belong there, and the generator is built for the connector protocol only.
 * When API schemas land in the package, this moves with them.
 */

import { ApiError } from "../../errors.ts";

/** What the control plane asks the gateway to carry. */
export interface GatewayRegisterRequest {
  readonly route_id: string;
  /**
   * The tenancy the route belongs to.
   *
   * The gateway does not resolve organisations and never infers one. It carries
   * this so that a control credential scoped to an organisation can be held to
   * it: enumeration, reads and revocation on that surface all take their scope
   * from the credential and compare it with this (ADR-0038).
   */
  readonly organisation_id: string;
  readonly project_id: string;
  readonly connector_id: string;
  readonly workspace_id: string;
  readonly public_alias: string;
  readonly local_host: string;
  readonly local_port: number;
  readonly protocol: string;
  readonly scope: string;
  readonly expires_at: string;
  readonly allowed_browser_session_ids: readonly string[];
  readonly observed_destination: string;
}

/** The gateway's account of a route. */
export interface GatewayRouteView {
  readonly route_id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly connector_id: string;
  readonly public_alias: string;
  readonly internal_origin: string;
  readonly status: string;
  readonly expires_at: string;
  readonly observed_destination: string;
  readonly connector_connected: boolean;
  readonly streams_opened: number;
  readonly streams_active: number;
  readonly bytes_to_destination: number;
  readonly bytes_from_destination: number;
}

interface GatewayEnvelope<T> {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
}

/** The gateway control API. */
export interface TunnelGateway {
  register(request: GatewayRegisterRequest): Promise<GatewayRouteView>;
  revokeRoute(routeId: string): Promise<void>;
  revokeCapability(capabilityId: string): Promise<void>;
}

export interface HttpTunnelGatewayOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** The HTTP implementation. */
export class HttpTunnelGateway implements TunnelGateway {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpTunnelGatewayOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async register(request: GatewayRegisterRequest): Promise<GatewayRouteView> {
    const response = await this.#send(
      "PUT",
      `/internal/v1/routes/${encodeURIComponent(request.route_id)}`,
      request,
    );
    const body = (await response.json()) as GatewayEnvelope<GatewayRouteView>;
    if (!response.ok || body.data === undefined) {
      // The gateway's refusal already carries a stable class from
      // docs/CONNECTOR_PROTOCOL.md section 21. Passing it through unchanged is
      // what keeps one failure one code all the way to the caller, and the
      // status that code maps to is the status the caller sees.
      throw new ApiError(
        (body.error?.code ?? "INTERNAL_ERROR") as ApiError["code"],
        "The tunnel gateway refused this publication.",
        asDetails(body.error?.details),
      );
    }
    return body.data;
  }

  async revokeRoute(routeId: string): Promise<void> {
    const response = await this.#send(
      "DELETE",
      `/internal/v1/routes/${encodeURIComponent(routeId)}`,
    );
    // A route the gateway has already forgotten is not an error: revocation is
    // idempotent, and the control plane's record is authoritative either way.
    if (!response.ok && response.status !== 404) {
      throw new ApiError(
        "INTERNAL_ERROR",
        "The tunnel gateway could not revoke this route.",
        undefined,
        502,
      );
    }
  }

  async revokeCapability(capabilityId: string): Promise<void> {
    const response = await this.#send(
      "DELETE",
      `/internal/v1/capabilities/${encodeURIComponent(capabilityId)}`,
    );
    if (!response.ok && response.status !== 404) {
      throw new ApiError(
        "INTERNAL_ERROR",
        "The tunnel gateway could not revoke this capability.",
        undefined,
        502,
      );
    }
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        // The token is a header and never a query parameter or a log field.
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiError("CONNECTOR_OFFLINE", "The tunnel gateway is not reachable.", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function asDetails(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}
