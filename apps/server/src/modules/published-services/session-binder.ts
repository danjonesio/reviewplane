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
 *
 * **This process acts under no authority of its own** (ADR-0037). It re-derives
 * every term from records the requesting process did not author — the route, its
 * connector, the project, the session — and refuses on any disagreement. It
 * cannot bind anything the route does not already authorise, because the
 * allow-list it checks was written by `PublishedServiceService.request`, which
 * validates every session named in it against the route's own project. The
 * reservation is a **request, not a grant**, and that distinction is what makes
 * it safe for a process holding a signing key to act on a row written by the
 * process that does not.
 */

import type { EventActor } from "../../events/append.ts";
import type {
  AllocationAuthoriser,
  ServiceBinder,
  ServiceBinding,
} from "../browser-sessions/service.ts";
import type { PublishedServiceService } from "./service.ts";

export class PublishedServiceBinder implements ServiceBinder, AllocationAuthoriser {
  readonly #services: PublishedServiceService;

  constructor(services: PublishedServiceService) {
    this.#services = services;
  }

  /**
   * **Entitlement only**, so a process with no signing key may run it.
   *
   * It answers "may this caller name these two records at all" — the four-term
   * scoped read and the route's own allow-list — and deliberately answers
   * nothing about whether the route is usable now.
   *
   * That restraint is the design and not an omission. A route status checked
   * here would look authoritative and be wrong the moment the route is revoked,
   * expires, or loses its connector between the request and the claim; the
   * process that mints re-reads all of it at the instant it acts. So an
   * entitlement refusal precedes the claim and leaves the reservation
   * `REQUESTED` and reusable, and a state refusal follows the claim and fails
   * it (ADR-0037).
   */
  async authorise(input: {
    readonly publishedServiceId: string;
    readonly organisationId: string;
    readonly projectId: string;
    readonly browserSessionId: string;
  }): Promise<void> {
    await this.#services.readAdmissible({
      publishedServiceId: input.publishedServiceId,
      browserSessionId: input.browserSessionId,
      scope: { organisationId: input.organisationId, projectIds: [input.projectId] },
    });
  }

  /**
   * Whether a route exists outside this caller's scope.
   *
   * For the audit trail alone; see {@link PublishedServiceService.existsUnscoped}.
   * Its answer never reaches a response.
   */
  async existsUnscoped(publishedServiceId: string): Promise<boolean> {
    return this.#services.existsUnscoped(publishedServiceId);
  }

  async bind(input: {
    readonly publishedServiceId: string;
    readonly organisationId: string;
    readonly projectId: string;
    readonly browserSessionId: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<ServiceBinding> {
    // One query, four terms: the route, the session, the organisation and the
    // project scope. It replaces a scoped read followed by an `if` on
    // `project_id`, and the scope it replaced was
    // `{ organisationId: null, projectIds: [input.projectId] }`.
    //
    // That was safe by construction and not by rule. `findInScope`'s project
    // term is specific and non-null, `projects.id` is a global primary key and
    // `projects.organisation_id` is `NOT NULL`, so a project implied its
    // organisation — but only while `input.projectId` was caller-derived, which
    // was a property of every caller rather than of this binder. `organisationId`
    // is now an argument and is never constructed here, so the term is present
    // whatever a future caller does (ADR-0037, RVP-91, RVP-92).
    const scope = {
      organisationId: input.organisationId,
      projectIds: [input.projectId],
    };
    const route = await this.#services.readBindable({
      publishedServiceId: input.publishedServiceId,
      browserSessionId: input.browserSessionId,
      scope,
    });
    const minted = await this.#services.mint(
      route.published_service_id,
      input.browserSessionId,
      undefined,
      scope,
      input.actor,
      input.requestId,
    );
    return {
      publishedServiceId: route.published_service_id,
      serviceOrigin: minted.internal_origin.replace(/\/$/u, ""),
      // reveal() is called exactly here, at the boundary where the credential
      // is handed to the session that will present it. It is re-wrapped as a
      // sensitive value before it reaches the worker frame.
      serviceCapability: minted.capability,
    };
  }
}
