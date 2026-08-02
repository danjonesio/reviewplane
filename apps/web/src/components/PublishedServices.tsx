/**
 * Publishing a development service, and the routes a project already holds
 * (`docs/UX_FLOWS.md` sections 6, 18 and 19; `docs/API.md` section 10;
 * `docs/DOMAIN_MODEL.md` section 10; `docs/CONNECTOR_PROTOCOL.md` section 11).
 *
 * A route is what gives a central browser something to open, so this surface
 * sits on the Live page beside the sessions it exists for. Three properties of
 * publication shape it.
 *
 * A route must name the browser sessions it authorises, and at least one
 * (`docs/CONNECTOR_PROTOCOL.md` section 11). A project with no session
 * therefore cannot publish at all, and the form says so where the choice would
 * have been rather than accepting a request the control plane would refuse.
 *
 * Publication is asked of another machine, so most of its failures are that
 * machine's. Each arrives as a stable class, and each class has one title and
 * one action in `PUBLICATION_REFUSALS` — what happened, and what the reader can
 * do — because `docs/UX_FLOWS.md` section 18 forbids answering a named cause
 * with a shrug. The same table renders a refused request and a `failed` route's
 * `failure_class`, so one failure reads the same wherever it is met.
 *
 * A connector that stopped reporting is not one that was revoked: the first may
 * recover on its own, the second is terminal and recovers only by enrolling a
 * new identity (section 18's last paragraph). The two are told apart wherever
 * the environment record can tell them apart.
 */

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactElement } from "react";

import {
  ApiFailure,
  api,
  isActive,
  type ConnectorStatus,
  type ConnectorSummary,
  type EnvironmentRecord,
  type PublishedService,
  type PublishedServiceDraft,
  type PublishedServiceStatus,
} from "../api/client.ts";
import { PUBLICATION_REFUSALS, RefusalPanel } from "./refusals.tsx";
import { StatusBadge, type Tone } from "./StatusBadge.tsx";

const FIELD =
  "rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const CARD =
  "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";

/** Connector states that can carry a new route. */
const CARRYING: readonly ConnectorStatus[] = ["ACTIVE", "DEGRADED"];

const TONE_FOR_SERVICE: Readonly<Record<PublishedServiceStatus, Tone>> = {
  requested: "waiting",
  ready: "live",
  failed: "failed",
  expired: "neutral",
  revoked: "neutral",
};

/**
 * What each status means, beside the word rather than instead of it. The badge
 * already carries the word, so colour is never the only signal
 * (`docs/UX_FLOWS.md` section 19).
 */
const SERVICE_MEANING: Readonly<Record<PublishedServiceStatus, string>> = {
  requested: "asked for; the gateway has not accepted it yet",
  ready: "carried, and reachable by the sessions it names",
  failed: "refused; nothing is carried",
  expired: "its lifetime elapsed and the streams were closed",
  revoked: "revoked; the streams were closed",
};

/**
 * A failed read, by its stable code.
 *
 * A read fails for reasons a publication's vocabulary does not describe — this
 * surface is administrator-only, and a project this session cannot reach is
 * answered `RESOURCE_NOT_FOUND` rather than with an empty list (`docs/API.md`
 * §10) — so the refusal table is not used here. `RESOURCE_NOT_FOUND` keeps the
 * unresolved wording section 18 requires; every other code is named as itself.
 */
function readFailure(error: unknown, fallback: string): string {
  if (!(error instanceof ApiFailure)) return fallback;
  if (error.code === "RESOURCE_NOT_FOUND") {
    return "This does not exist, or this session is not authorised for it.";
  }
  return `${error.code}: ${error.message}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** "in 59 minutes", beside the absolute time rather than instead of it. */
function relativeToNow(value: string): string {
  const delta = new Date(value).getTime() - Date.now();
  if (Number.isNaN(delta)) return "";
  const seconds = Math.round(delta / 1000);
  if (Math.abs(seconds) < 90) return RELATIVE.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(hours / 24), "day");
}

/** The connector of this environment that could carry a route, if any. */
function carrier(environment: EnvironmentRecord): ConnectorSummary | undefined {
  return environment.connectors.find((connector) => CARRYING.includes(connector.status));
}

/**
 * Why this project has nothing to publish through, as a clause.
 *
 * The three cases differ in what the reader should do, which is exactly why
 * `docs/UX_FLOWS.md` section 18 requires a stopped connector and a revoked one
 * to be told apart: the first may repair itself and the second never does.
 */
function absenceReason(environments: readonly EnvironmentRecord[]): string {
  const statuses = environments.flatMap((environment) =>
    environment.connectors.map((connector) => connector.status),
  );
  if (statuses.includes("DISCONNECTED") || statuses.includes("PENDING_ENROLMENT")) {
    return "this project's connector has stopped reporting, which is a health state it may recover from on its own once it dials back in";
  }
  if (statuses.includes("REVOKED")) {
    return "this project's connector was revoked, which is terminal: that identity is refused before a channel is established, and only enrolling a new one restores publication";
  }
  return "no connector has enrolled into this project yet";
}

/** One route, with what it reaches, what it authorises, and when it lapses. */
function RouteCard({
  service,
  connectors,
  onRevoke,
  revoking,
}: {
  readonly service: PublishedService;
  readonly connectors: ReadonlyMap<string, ConnectorSummary>;
  readonly onRevoke: (service: PublishedService) => void;
  readonly revoking: boolean;
}): ReactElement {
  const holder = connectors.get(service.connector_id);
  // A connector outage makes a route unavailable rather than revoked: the
  // record survives and resumes under the same identifier when the connector
  // reconnects (`docs/DOMAIN_MODEL.md` section 10). Saying "revoked" here would
  // send a reader to publish a replacement they do not need.
  const stranded = service.status === "ready" && (holder === undefined || !CARRYING.includes(holder.status));

  return (
    <li className={CARD} data-published-service={service.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h5 className="min-w-0 break-all font-mono text-sm font-semibold">
          {service.internal_origin}
        </h5>
        <StatusBadge
          tone={TONE_FOR_SERVICE[service.status] ?? "neutral"}
          label={service.status.toUpperCase()}
          detail={SERVICE_MEANING[service.status] ?? "status unknown"}
        />
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Development machine</dt>
          <dd className="break-all font-mono">
            {service.protocol}://{service.local_host}:{String(service.local_port)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Observed destination</dt>
          <dd className="break-all font-mono" data-observed={service.id}>
            {service.observed_destination ?? "not reported"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Expires</dt>
          <dd data-expires={service.id}>
            {new Date(service.expires_at).toLocaleString()} ({relativeToNow(service.expires_at)})
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Scope</dt>
          <dd className="font-mono">{service.scope}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-slate-600 dark:text-slate-400">Authorised browser sessions</dt>
          <dd className="break-all font-mono text-xs">
            {service.allowed_browser_session_ids.length === 0
              ? "none, which is a route nothing may use"
              : service.allowed_browser_session_ids.join(", ")}
          </dd>
        </div>
      </dl>

      {service.status === "failed" ? (
        <RefusalPanel
          code={service.failure_class ?? "PUBLISHED_SERVICE_UNAVAILABLE"}
          message="The publication was refused."
          attribute="data-failure"
          table={PUBLICATION_REFUSALS}
        />
      ) : null}

      {stranded ? (
        <div
          data-route-stranded={service.id}
          className="mt-3 rounded border border-amber-600 p-3 dark:border-amber-500"
        >
          <h5 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            The tunnel is unavailable
          </h5>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            {holder?.status === "REVOKED"
              ? "The connector that carries this route was revoked. That is terminal: the route cannot resume, and publishing again means enrolling a new connector first."
              : "The connector that carries this route has stopped reporting. The record survives and the route resumes under this identifier if the connector dials back in before it expires."}
          </p>
        </div>
      ) : null}

      {service.status === "ready" ? (
        <p className="mt-3">
          <button
            type="button"
            data-revoke-service={service.id}
            disabled={revoking}
            onClick={() => {
              onRevoke(service);
            }}
            className="rounded border border-red-700 px-3 py-2 text-sm font-medium text-red-800 disabled:opacity-60 dark:border-red-500 dark:text-red-300"
          >
            {revoking ? "Revoking…" : "Revoke route"}
          </button>
        </p>
      ) : null}
    </li>
  );
}

/** The report a publication or a revocation leaves in the live region. */
function publicationSentence(service: PublishedService): string {
  return `Route ${service.public_alias} is ${service.status}. ${service.internal_origin} reaches ${service.protocol}://${service.local_host}:${String(service.local_port)} on the development machine, for ${String(service.allowed_browser_session_ids.length)} authorised browser ${service.allowed_browser_session_ids.length === 1 ? "session" : "sessions"}.`;
}

function revocationSentence(service: PublishedService): string {
  return `Route ${service.public_alias} is ${service.status}. Its streams are closed and the browser sessions it authorised can no longer reach the development machine through it.`;
}

export function PublishedServices({ projectId }: { readonly projectId: string }): ReactElement {
  const queryClient = useQueryClient();
  const [activity, setActivity] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);

  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api.environments(projectId),
    refetchInterval: 5000,
    retry: false,
  });
  const sessions = useQuery({
    queryKey: ["browser-sessions", projectId],
    queryFn: () => api.browserSessions(projectId),
    refetchInterval: 5000,
    retry: false,
  });
  // A route is asked of another machine and answered by a third, so its status
  // moves after the request that created it has returned.
  const services = useQuery({
    queryKey: ["published-services", projectId],
    queryFn: () => api.publishedServices(projectId),
    refetchInterval: 5000,
    retry: false,
  });

  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [localHost, setLocalHost] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState("");
  const [protocol, setProtocol] = useState("http");
  const [lifetime, setLifetime] = useState("3600");
  const [authorised, setAuthorised] = useState<readonly string[]>([]);

  const records = environments.data ?? [];
  const publishable = records.filter((environment) => carrier(environment) !== undefined);
  // The select is the reader's choice where they made one and the first
  // publishable environment until they do, so nothing has to be synchronised
  // into state as the list arrives.
  const environment = publishable.find((candidate) => candidate.id === environmentId) ?? publishable[0];
  const connector = environment === undefined ? undefined : carrier(environment);
  const workspaces = environment?.workspaces ?? [];
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? workspaces[0];
  const startable = (sessions.data ?? []).filter((session) => isActive(session));

  const connectors = new Map<string, ConnectorSummary>(
    records.flatMap((record) =>
      record.connectors.map((entry) => [entry.id, entry] as const),
    ),
  );

  const publish = useMutation({
    mutationFn: async (draft: PublishedServiceDraft) => api.publishService(projectId, draft),
    onSuccess: async (service) => {
      setActivity(publicationSentence(service));
      await queryClient.invalidateQueries({ queryKey: ["published-services", projectId] });
    },
  });

  const revoke = useMutation({
    mutationFn: async (serviceId: string) => api.revokePublishedService(serviceId),
    onSuccess: async (service) => {
      setActivity(revocationSentence(service));
      await queryClient.invalidateQueries({ queryKey: ["published-services", projectId] });
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (connector === undefined || workspace === undefined) return;
    const port = Number.parseInt(localPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setInvalid("Give the port the development server listens on, between 1 and 65535.");
      return;
    }
    const ttl = Number.parseInt(lifetime, 10);
    if (!Number.isInteger(ttl) || ttl < 1) {
      setInvalid("Give the route's lifetime in seconds. Publication expires by itself.");
      return;
    }
    if (authorised.length === 0) {
      setInvalid(
        "Choose at least one browser session for this route to authorise. A route that names none is not published.",
      );
      return;
    }
    setInvalid(null);
    publish.mutate({
      connector_id: connector.id,
      workspace_id: workspace.id,
      local_host: localHost,
      local_port: port,
      protocol,
      ttl_seconds: ttl,
      allowed_browser_session_ids: authorised,
    });
  }

  const listed = services.data ?? [];

  return (
    <section aria-labelledby="published-services-heading" className="mt-10">
      <h3 id="published-services-heading" className="text-lg font-semibold">
        Published development services
      </h3>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        A published service is a temporary route from a central browser worker to a port on the
        development machine. The connector dials out to carry it, nothing listens publicly, and only
        the browser sessions the route names may use it.
      </p>

      {/* Outcomes are announced here without moving focus. */}
      <p
        id="published-services-activity"
        role="status"
        aria-live="polite"
        className="mt-3 text-sm text-slate-700 dark:text-slate-300"
      >
        {activity}
      </p>

      {environments.isError ? (
        <p role="alert" className="mt-3 text-sm font-medium text-red-800 dark:text-red-300">
          {readFailure(environments.error, "The environments could not be read.")}
        </p>
      ) : null}

      {!environments.isPending && !environments.isError && publishable.length === 0 ? (
        <div className={`mt-4 ${CARD}`} data-empty="published-services">
          <h4 className="text-base font-semibold">No connector is connected</h4>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            There is nothing to publish yet, because {absenceReason(records)}. This is not a fault:
            until a connector is connected, this project has no development service to publish, so a
            central browser session has no application to open and a review has nothing to be
            captured against.
          </p>
          <p className="mt-3 text-sm">
            <Link
              to="/projects/$projectId/environments/enrol"
              params={{ projectId }}
              className="underline underline-offset-4"
            >
              Enrol a connector for this project
            </Link>
          </p>
          <p className="mt-2 text-sm">
            <Link
              to="/projects/$projectId/environments"
              params={{ projectId }}
              className="underline underline-offset-4"
            >
              See this project&apos;s environments
            </Link>
          </p>
        </div>
      ) : null}

      {environment === undefined || connector === undefined ? null : (
        <form className="mt-4 flex flex-col gap-5" onSubmit={submit} data-publish-form={environment.id}>
          <h4 className="text-base font-semibold">Publish a development service</h4>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="publish-environment" className="text-sm font-medium">
                Development environment
              </label>
              <select
                id="publish-environment"
                name="publish-environment"
                value={environment.id}
                onChange={(event) => {
                  setEnvironmentId(event.target.value);
                  // The workspaces belong to the environment, so a choice made
                  // against the previous one would name a checkout this
                  // connector does not report.
                  setWorkspaceId(null);
                }}
                className={FIELD}
                aria-describedby="publish-environment-hint"
              >
                {publishable.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <p id="publish-environment-hint" className={HINT}>
                Published through connector <span className="font-mono">{connector.id}</span>, which
                is the one this environment currently has connected.
              </p>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="publish-workspace" className="text-sm font-medium">
                Checkout
              </label>
              {workspaces.length === 0 ? (
                <p
                  id="publish-workspace-empty"
                  data-empty="workspaces"
                  className="text-sm text-slate-700 dark:text-slate-300"
                >
                  This environment has not reported a checkout yet. A route is associated with the
                  checkout it serves, so publication waits for the connector to report one.
                </p>
              ) : (
                <select
                  id="publish-workspace"
                  name="publish-workspace"
                  value={workspace?.id ?? ""}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                  }}
                  className={FIELD}
                >
                  {workspaces.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.display_path} on {candidate.branch}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="publish-local-host" className="text-sm font-medium">
                Local host
              </label>
              <input
                id="publish-local-host"
                name="publish-local-host"
                type="text"
                value={localHost}
                onChange={(event) => {
                  setLocalHost(event.target.value);
                }}
                className={`${FIELD} font-mono`}
                aria-describedby="publish-local-host-hint"
              />
              <p id="publish-local-host-hint" className={HINT}>
                Loopback by default. The destination is fixed when the route is published and cannot
                be changed by anything travelling through it.
              </p>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="publish-local-port" className="text-sm font-medium">
                Local port
              </label>
              <input
                id="publish-local-port"
                name="publish-local-port"
                type="number"
                min={1}
                max={65535}
                value={localPort}
                onChange={(event) => {
                  setLocalPort(event.target.value);
                }}
                className={`${FIELD} font-mono`}
                aria-describedby="publish-local-port-hint"
              />
              <p id="publish-local-port-hint" className={HINT}>
                The port the development server listens on. The connector waits a bounded moment for
                it to appear and then refuses rather than waiting indefinitely.
              </p>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="publish-protocol" className="text-sm font-medium">
                Protocol
              </label>
              <select
                id="publish-protocol"
                name="publish-protocol"
                value={protocol}
                onChange={(event) => {
                  setProtocol(event.target.value);
                }}
                className={FIELD}
              >
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="publish-ttl" className="text-sm font-medium">
                Route lifetime (seconds)
              </label>
              <input
                id="publish-ttl"
                name="publish-ttl"
                type="number"
                min={1}
                value={lifetime}
                onChange={(event) => {
                  setLifetime(event.target.value);
                }}
                className={`${FIELD} font-mono`}
                aria-describedby="publish-ttl-hint"
              />
              <p id="publish-ttl-hint" className={HINT}>
                Publication expires automatically. Choose the shortest lifetime that covers the
                work; a route can always be published again.
              </p>
            </div>
          </div>

          <fieldset className="min-w-0 border-0 p-0">
            <legend className="text-sm font-medium">Browser sessions this route authorises</legend>
            {startable.length === 0 ? (
              // A route must name at least one session
              // (`docs/CONNECTOR_PROTOCOL.md` section 11), so a project with
              // none cannot publish. Saying that here is the difference between
              // a form a reader can complete and one that refuses on submit.
              <div className="mt-2" data-empty="browser-sessions">
                <p className="text-sm text-slate-700 dark:text-slate-300">
                  No browser session is running in this project, and a route must authorise at least
                  one: a route no session may use is not published at all. A session appears here as
                  soon as an agent or an operator starts one, and publication is possible then.
                </p>
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {startable.map((session) => (
                  <label
                    key={session.id}
                    htmlFor={`publish-session-${session.id}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <input
                      id={`publish-session-${session.id}`}
                      name="publish-session"
                      type="checkbox"
                      className="h-4 w-4"
                      checked={authorised.includes(session.id)}
                      onChange={(event) => {
                        setAuthorised((current) =>
                          event.target.checked
                            ? [...current, session.id]
                            : current.filter((entry) => entry !== session.id),
                        );
                      }}
                    />
                    <span className="min-w-0 break-all font-mono text-xs">{session.id}</span>
                    <StatusBadge tone="neutral" label={session.status} />
                  </label>
                ))}
              </div>
            )}
            <p className={`mt-2 ${HINT}`}>
              The route is scoped to the sessions named here and to no others. Naming a session does
              not start it, and a session started later needs a route of its own.
            </p>
          </fieldset>

          {startable.length === 0 || workspaces.length === 0 ? null : (
            <button
              type="submit"
              id="publish-submit"
              disabled={publish.isPending}
              className="self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
            >
              {publish.isPending ? "Publishing…" : "Publish development service"}
            </button>
          )}

          {invalid === null ? null : (
            <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
              {invalid}
            </p>
          )}

          {publish.error === null ? null : (
            <RefusalPanel
              code={publish.error instanceof ApiFailure ? publish.error.code : "INTERNAL_ERROR"}
              message={
                publish.error instanceof ApiFailure
                  ? publish.error.message
                  : "The development service could not be published."
              }
              attribute="data-refusal"
              table={PUBLICATION_REFUSALS}
            />
          )}
        </form>
      )}

      <h4 className="mt-8 text-base font-semibold">Routes this project holds</h4>

      {services.isError ? (
        <p role="alert" className="mt-2 text-sm font-medium text-red-800 dark:text-red-300">
          {readFailure(services.error, "The published services could not be read.")}
        </p>
      ) : null}

      {!services.isPending && !services.isError && listed.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300" data-empty="routes">
          No development service is published in this project. A browser session reaches an
          application only through a route, so nothing here means nothing for a session to open.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {listed.map((service) => (
            <RouteCard
              key={service.id}
              service={service}
              connectors={connectors}
              revoking={revoke.isPending && revoke.variables === service.id}
              onRevoke={(target) => {
                revoke.mutate(target.id);
              }}
            />
          ))}
        </ul>
      )}

      {revoke.error === null ? null : (
        <RefusalPanel
          code={revoke.error instanceof ApiFailure ? revoke.error.code : "INTERNAL_ERROR"}
          message={
            revoke.error instanceof ApiFailure
              ? revoke.error.message
              : "The route could not be revoked."
          }
          attribute="data-refusal"
          table={PUBLICATION_REFUSALS}
        />
      )}
    </section>
  );
}
