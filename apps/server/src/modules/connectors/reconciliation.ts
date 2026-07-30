/**
 * The control plane's half of reconnect reconciliation
 * (`docs/CONNECTOR_PROTOCOL.md` §17).
 *
 * Reconciliation is a three-way comparison: what the connector believes it is
 * serving, what this control plane has authorised, and what has expired in the
 * meantime. The control plane's answer wins in every case — not as a courtesy
 * but because the alternative is a route that outlives its authorisation
 * through a reconnect, which would make reconnecting a way to extend access
 * silently (`docs/SECURITY.md` §9).
 *
 * The decision function here is pure so that the table can be read, tested and
 * argued with. Everything it needs is passed in; nothing it decides is applied
 * here. `../published-services/reconciliation.ts` applies it, because that is
 * where the routes, the gateway and the events live.
 */

import type {
  ReconnectRequest,
  ReconnectResponse,
  RouteDecision,
  RoutePublish,
  SessionDecision,
} from "@reviewplane/protocol";

/**
 * The schema's bound on `routes` and `sessions` in one desired state. A
 * deployment carrying more than this per connector reconciles the first routes
 * by identifier; anything the response does not name is not authorised, and the
 * connector closes it, so truncation fails closed.
 */
export const MAX_DECISIONS = 16;

/** A route as this control plane holds it. */
export interface AuthoritativeRoute {
  readonly routeId: string;
  readonly projectId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly protocol: "http" | "https";
  readonly expiresAt: Date;
  readonly status: string;
  readonly allowedBrowserSessionIds: readonly string[];
  readonly observedDestination: string | null;
}

/** A route the connector claims it is still serving. */
export interface ClaimedRoute {
  readonly routeId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly observedDestination: string;
  readonly expiresAt: string;
}

/** What the applier must do to the control plane's own record. */
export type RouteClosure = "expired" | "revoked" | "none";

export interface ReconciledRoute {
  readonly decision: RouteDecision;
  /**
   * Whether the control plane's own record must be ended, and as what. `none`
   * covers a route this control plane never had, or one it had already ended:
   * neither is a state change here, and neither may produce a second event.
   */
  readonly closure: RouteClosure;
  /** The record the decision was made against, when one exists. */
  readonly record: AuthoritativeRoute | null;
}

export interface ReconciliationInput {
  readonly connectorId: string;
  readonly claimed: readonly ClaimedRoute[];
  /**
   * Every route this connector holds in a live status, plus every route named
   * in `claimed` whoever owns it. The second half is what lets a claim on
   * another connector's route be refused rather than silently ignored.
   */
  readonly authoritative: readonly AuthoritativeRoute[];
  readonly now: Date;
}

/** Renders a destination the way the connector and the gateway both do. */
export function formatDestination(host: string, port: number): string {
  const rendered = host.includes(":") ? `[${host}]` : host;
  return `${rendered}:${String(port)}`;
}

function restate(record: AuthoritativeRoute): RoutePublish {
  return {
    route_id: record.routeId,
    project_id: record.projectId,
    workspace_id: record.workspaceId,
    local_host: record.localHost,
    local_port: record.localPort,
    protocol: record.protocol,
    expires_at: record.expiresAt.toISOString(),
    allowed_browser_session_ids: [...record.allowedBrowserSessionIds],
  };
}

function revoke(
  routeId: string,
  reason: RouteDecision["reason"],
  closure: RouteClosure,
  record: AuthoritativeRoute | null,
): ReconciledRoute {
  return { decision: { route_id: routeId, decision: "revoke", reason }, closure, record };
}

/**
 * The reconciliation decision table.
 *
 * Where the two views disagree about a route that is still within its TTL, is
 * still authorised for this connector and still points where the record says it
 * points, the answer is continue. In every other case it is revoke.
 */
export function reconcileRoutes(input: ReconciliationInput): ReconciledRoute[] {
  const byId = new Map<string, AuthoritativeRoute>();
  for (const record of input.authoritative) byId.set(record.routeId, record);

  const decisions = new Map<string, ReconciledRoute>();

  for (const claim of input.claimed) {
    if (decisions.has(claim.routeId)) continue;
    const record = byId.get(claim.routeId);

    if (record === undefined) {
      // A route this control plane has no record of. It must not keep serving
      // traffic, and there is nothing here to end.
      decisions.set(claim.routeId, revoke(claim.routeId, "unknown_route", "none", null));
      continue;
    }
    if (record.connectorId !== input.connectorId) {
      // A reconnect from one identity must not inherit another's routes
      // (`docs/ARCHITECTURE.md` §14). The other connector's record is left
      // untouched: this connector's claim on it is refused, not honoured in
      // reverse.
      decisions.set(claim.routeId, revoke(claim.routeId, "not_authorised", "none", record));
      continue;
    }
    if (record.status === "expired") {
      decisions.set(claim.routeId, revoke(claim.routeId, "expired", "none", record));
      continue;
    }
    if (record.status !== "ready") {
      // Revoked, failed, or still mid-publication. None of those is a route the
      // connector may go on serving.
      const closure: RouteClosure = record.status === "requested" ? "revoked" : "none";
      decisions.set(claim.routeId, revoke(claim.routeId, "revoked", closure, record));
      continue;
    }
    if (record.expiresAt.getTime() <= input.now.getTime()) {
      decisions.set(claim.routeId, revoke(claim.routeId, "expired", "expired", record));
      continue;
    }
    if (claim.projectId !== record.projectId || claim.workspaceId !== record.workspaceId) {
      // The connector believes the route belongs somewhere else. That is a
      // disagreement about authorisation, so it fails closed.
      decisions.set(claim.routeId, revoke(claim.routeId, "not_authorised", "revoked", record));
      continue;
    }
    const authoritativeDestination =
      record.observedDestination ?? formatDestination(record.localHost, record.localPort);
    if (claim.observedDestination !== authoritativeDestination) {
      // `docs/ARCHITECTURE.md` §14: traffic must never be silently redirected to
      // a different environment. A connector serving a destination the record
      // does not name is exactly that, so the route is closed rather than
      // continued.
      decisions.set(claim.routeId, revoke(claim.routeId, "destination_mismatch", "revoked", record));
      continue;
    }
    decisions.set(claim.routeId, {
      decision: {
        route_id: record.routeId,
        decision: "continue",
        reason: "authorised",
        route: restate(record),
      },
      closure: "none",
      record,
    });
  }

  // Routes this control plane holds that the connector did not claim. This is
  // the process-restart case: the connector lost its in-memory route table, and
  // the route resumes under the same identifier without re-publication.
  for (const record of input.authoritative) {
    if (record.connectorId !== input.connectorId) continue;
    if (record.status !== "ready") continue;
    if (decisions.has(record.routeId)) continue;
    if (record.expiresAt.getTime() <= input.now.getTime()) {
      decisions.set(record.routeId, revoke(record.routeId, "expired", "expired", record));
      continue;
    }
    decisions.set(record.routeId, {
      decision: {
        route_id: record.routeId,
        decision: "continue",
        reason: "authorised",
        route: restate(record),
      },
      closure: "none",
      record,
    });
  }

  return [...decisions.values()].sort((left, right) =>
    left.decision.route_id < right.decision.route_id ? -1 : 1,
  );
}

/**
 * Session decisions derived from the route decisions.
 *
 * A session whose route resumed is told to re-establish; a session that only
 * had routes closed is told to end. A session named by both keeps the
 * re-establish, because the route it can still use is the one that matters.
 */
export function decideSessions(routes: readonly ReconciledRoute[]): SessionDecision[] {
  const resumed = new Set<string>();
  const ended = new Set<string>();
  for (const entry of routes) {
    const sessions = entry.record?.allowedBrowserSessionIds ?? [];
    for (const session of sessions) {
      if (entry.decision.decision === "continue") resumed.add(session);
      else ended.add(session);
    }
  }
  const decisions: SessionDecision[] = [];
  for (const session of [...resumed].sort()) {
    decisions.push({ browser_session_id: session, decision: "re_establish", reason: "route_resumed" });
  }
  for (const session of [...ended].sort()) {
    if (resumed.has(session)) continue;
    decisions.push({ browser_session_id: session, decision: "end", reason: "route_revoked" });
  }
  return decisions.slice(0, MAX_DECISIONS);
}

/** Version policy for the §19 classification. */
export interface UpgradePolicy {
  /** Below this the connector is refused with `upgrade_required`. */
  readonly minimumVersion: string;
  /** Below this an upgrade is recommended but the connector still runs. */
  readonly recommendedVersion: string;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split(/[.+-]/u)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Classifies a reported connector version (`docs/CONNECTOR_PROTOCOL.md` §19).
 *
 * Stage 0 defaults are permissive, because refusing a connector is an operator
 * decision rather than a default. `unsupported` is not produced from a version
 * comparison: a build that cannot speak this protocol version never reaches
 * here, because the frame decoder refuses it as `PROTOCOL_UNSUPPORTED` first.
 */
export function classifyUpgrade(
  reportedVersion: string,
  policy: UpgradePolicy,
): ReconnectResponse["upgrade"] {
  if (compareVersions(reportedVersion, policy.minimumVersion) < 0) return "upgrade_required";
  if (compareVersions(reportedVersion, policy.recommendedVersion) < 0) return "upgrade_recommended";
  return "compatible";
}

/**
 * Applies reconciliation and answers the connector.
 *
 * It is an interface so that the connector channel does not depend on the
 * published-service module: the channel authenticates and decodes, and the
 * module that owns routes decides what happens to them.
 */
export interface ConnectorReconciler {
  /**
   * Reconciles one reconnect and returns the authoritative desired state.
   */
  reconcile(input: {
    readonly connectorId: string;
    readonly request: ReconnectRequest;
    readonly requestId: string;
  }): Promise<ReconnectResponse>;

  /**
   * Records that a connector's channel has gone: routes become unavailable and
   * affected browser sessions are marked degraded rather than terminated
   * (`docs/ARCHITECTURE.md` §14, `docs/DOMAIN_MODEL.md` §12).
   */
  handleDisconnect(input: {
    readonly connectorId: string;
    readonly requestId: string;
  }): Promise<void>;
}

/** Truncates decisions to the schema bound, deterministically. */
export function boundDecisions(routes: readonly ReconciledRoute[]): ReconciledRoute[] {
  return routes.slice(0, MAX_DECISIONS);
}
