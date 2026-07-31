/**
 * Binds a published service to a browser session.
 *
 * This is the one place a browser session learns which origin it may reach and
 * gets the credential to reach it. Both come from the route record, never from
 * the caller: the origin *is* the worker's egress allow-list (`docs/SECURITY.md`
 * §9), and the capability is a bearer credential the control plane alone mints
 * (`docs/ARCHITECTURE.md` §7.3).
 *
 * The route must already name this session in `allowed_browser_session_ids`,
 * which is why the session identifier is reserved before the route is
 * published. Minting for a session the route does not authorise is refused
 * here, so the gateway never has to refuse a capability the control plane
 * should not have issued.
 */

import type { EventActor } from "../../events/append.ts";
import { ApiError } from "../../errors.ts";
import type { ServiceBinder, ServiceBinding } from "../browser-sessions/service.ts";
import type { PublishedServiceService } from "./service.ts";

export class PublishedServiceBinder implements ServiceBinder {
  readonly #services: PublishedServiceService;

  constructor(services: PublishedServiceService) {
    this.#services = services;
  }

  async bind(input: {
    readonly publishedServiceId: string;
    readonly projectId: string;
    readonly browserSessionId: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<ServiceBinding> {
    // The project is checked before anything is minted, so a cross-project
    // request never produces a credential that then has to be revoked. It is
    // checked **twice, differently**: the read is scoped to the session's
    // project so that a route in another one is simply absent, and the equality
    // below then states the same rule where a reader can see it. The scoped
    // read is the enforcement; the comparison is what makes a future change to
    // the read visible as a test failure rather than as a silent widening.
    const scope = { organisationId: null, projectIds: [input.projectId] };
    const service = await this.#services.read(input.publishedServiceId, scope);
    if (service.project_id !== input.projectId) {
      // A session may only route to a service authorised for the same project
      // (`docs/DOMAIN_MODEL.md` §6 invariants). The capability the gateway
      // verifies carries the project too, so this is defence in depth rather
      // than the only check — but the control plane should not issue a
      // credential it knows to be wrong.
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "That published service belongs to another project.",
        { published_service_id: input.publishedServiceId },
      );
    }
    const minted = await this.#services.mint(
      input.publishedServiceId,
      input.browserSessionId,
      undefined,
      scope,
      input.actor,
      input.requestId,
    );
    return {
      publishedServiceId: input.publishedServiceId,
      serviceOrigin: minted.internal_origin.replace(/\/$/u, ""),
      // reveal() is called exactly here, at the boundary where the credential
      // is handed to the session that will present it. It is re-wrapped as a
      // sensitive value before it reaches the worker frame.
      serviceCapability: minted.capability,
    };
  }
}
