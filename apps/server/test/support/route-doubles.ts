/**
 * The two peers a publication needs, for tests that are not exercising them.
 *
 * Publishing a route reaches a connector and a tunnel gateway. Both have their
 * own suites — `apps/server/test/route-publication.test.ts` against a real
 * connector binary, and `services/tunnel-gateway` for the gateway — so a test
 * whose subject is something else needs peers rather than a second copy of
 * either. Keeping them here rather than in one harness lets another package
 * reach them through `@reviewplane/server/testing/publishing`.
 */

import type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../../src/modules/published-services/gateway-client.ts";

export { StubRoutePublisher } from "../../src/modules/published-services/service.ts";
export type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../../src/modules/published-services/gateway-client.ts";

/**
 * A tunnel gateway that accepts every registration and remembers it.
 *
 * It reports the route as ready with its connector connected. The origin a
 * session is bound to is still computed by the control plane from the route
 * record (`modules/published-services/service.ts`), so this double cannot
 * choose what a browser session may reach.
 */
export class AcceptingGateway implements TunnelGateway {
  readonly registered: GatewayRegisterRequest[] = [];
  readonly revokedRoutes: string[] = [];
  /**
   * Capability identifiers the control plane asked the gateway to withdraw.
   *
   * Recorded rather than discarded, because "the control plane told the gateway"
   * is an assertion a test has to be able to make. It is **not** an assertion
   * that the gateway then refuses the capability: the gateway verifies from a
   * signature without a database read, so what a double records is the call and
   * never the refusal. That the refusal is durable — that it outlives the
   * gateway process and is not undone by registering the route identifier again
   * — is proven where it is implemented, in
   * `services/tunnel-gateway/internal/registry` and
   * `services/tunnel-gateway/internal/gatewayhttp` (ADR-0038).
   */
  readonly revokedCapabilities: string[] = [];

  register(request: GatewayRegisterRequest): Promise<GatewayRouteView> {
    this.registered.push(request);
    return Promise.resolve({
      route_id: request.route_id,
      organisation_id: request.organisation_id,
      project_id: request.project_id,
      connector_id: request.connector_id,
      public_alias: request.public_alias,
      internal_origin: `https://${request.public_alias}.internal.invalid/`,
      status: "ready",
      expires_at: request.expires_at,
      observed_destination: request.observed_destination,
      connector_connected: true,
      streams_opened: 0,
      streams_active: 0,
      bytes_to_destination: 0,
      bytes_from_destination: 0,
    });
  }

  revokeRoute(routeId: string): Promise<void> {
    this.revokedRoutes.push(routeId);
    return Promise.resolve();
  }

  revokeCapability(capabilityId: string): Promise<void> {
    this.revokedCapabilities.push(capabilityId);
    return Promise.resolve();
  }
}
