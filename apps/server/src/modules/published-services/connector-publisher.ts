/**
 * The real {@link RoutePublisher}: the `route.publish` exchange of
 * `docs/CONNECTOR_PROTOCOL.md` §11, over the control channel the connector
 * already holds open.
 *
 * The control plane decides and the connector validates independently. This is
 * where the two meet, and it deliberately does not second-guess the answer: a
 * `rejected` acknowledgement carries a stable class from §21, and that class is
 * what the caller and the published-service record both see. Renaming it here
 * would break the property `docs/API.md` §10 states — one failure, one code,
 * from the connector to the caller.
 */

import type { RoutePublishAck } from "@reviewplane/protocol";

import { ApiError } from "../../errors.ts";
import type { ApiErrorCode } from "../../errors.ts";
import type { ControlChannelRegistry } from "../connectors/publication.ts";
import type { RoutePublisher } from "./service.ts";

export class ConnectorRoutePublisher implements RoutePublisher {
  readonly #channels: ControlChannelRegistry;

  constructor(channels: ControlChannelRegistry) {
    this.#channels = channels;
  }

  async publish(input: {
    readonly routeId: string;
    readonly projectId: string;
    readonly connectorId: string;
    readonly workspaceId: string;
    readonly localHost: string;
    readonly localPort: number;
    readonly protocol: string;
    readonly expiresAt: Date;
    readonly allowedBrowserSessionIds: readonly string[];
  }): Promise<{ readonly observedDestination: string }> {
    const ack: RoutePublishAck = await this.#channels.publish(input.connectorId, {
      route_id: input.routeId,
      project_id: input.projectId,
      workspace_id: input.workspaceId,
      local_host: input.localHost,
      local_port: input.localPort,
      protocol: input.protocol as "http" | "https",
      expires_at: input.expiresAt.toISOString(),
      allowed_browser_session_ids: [...input.allowedBrowserSessionIds],
    });

    if (ack.status === "rejected") {
      // §11: a rejected acknowledgement carries an error class and no free
      // text. The class is the diagnosis.
      const code = (ack.error_class ?? "CONTROL_PLANE_UNAVAILABLE") as ApiErrorCode;
      throw new ApiError(code, "The connector refused this publication.", {
        route_id: input.routeId,
        connector_id: input.connectorId,
      });
    }
    if (ack.observed_destination === undefined) {
      // The schema requires it on a ready acknowledgement, so this is a peer
      // that passed validation and still answered incoherently. Refusing is
      // safer than inventing the destination the control plane asked for.
      throw new ApiError(
        "CONTROL_PLANE_UNAVAILABLE",
        "The connector acknowledged this publication without naming a destination.",
        { route_id: input.routeId },
      );
    }
    return { observedDestination: ack.observed_destination };
  }
}
