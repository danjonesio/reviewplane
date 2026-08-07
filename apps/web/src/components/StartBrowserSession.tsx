/**
 * Starting a central browser session (`docs/UX_FLOWS.md` sections 6, 18 and
 * 19; `docs/API.md` section 11; `docs/DOMAIN_MODEL.md` section 12).
 *
 * Section 6's human flow is five steps — choose the environment and service,
 * choose a viewport preset, choose the trace and video policy, start, open the
 * session room — and this surface is the first four of them, with the fifth as
 * the link it leaves behind.
 *
 * Three things shape it.
 *
 * A session reaches an application only through a published route, and a
 * session with no route is a legitimate thing to start: an empty browser is
 * still a browser. The choice is therefore explicit in both directions, because
 * a select left blank would be indistinguishable from one nobody had got to
 * yet, and the difference decides whether the session can open anything.
 *
 * **The route is not chosen here, and that is the correction ADR-0037 made.**
 * This surface offered a select of published routes on a one-request start, and
 * that combination cannot succeed against the real control plane: a route names
 * the browser sessions it authorises when it is published
 * (`CONNECTOR_PROTOCOL.md` §11), so a route published before this session
 * existed does not name it, and `mint` refuses. The browser suite did not catch
 * it because the stub bound any route to a freshly minted identifier without
 * consulting `allowed_browser_session_ids`; the stub enforces it now.
 *
 * So a session that is meant to reach an application is **reserved** here, the
 * route is published against the reservation with the form below, and the
 * reservation is then allocated. That is the order `API.md` §11 documents and
 * the one the agent surface uses (`MCP_SPEC.md` §7.3). It is three steps because
 * the constraint is real, and a select that hid it produced a session that
 * silently reached nothing.
 *
 * Trace and video are step 3 of the flow and are not implemented at this stage.
 * They are shown disabled and said to be unavailable rather than omitted: a
 * missing step reads as a step that does not exist, and a reader who was told
 * to set a trace policy would go looking for a control that had been quietly
 * deleted.
 *
 * Chromium runs on the deployment, not on the reader's machine and not on the
 * development machine, and the application is reached back over the connector's
 * outbound tunnel. Section 6 requires the interface to say so, because nothing
 * else on screen distinguishes this from a browser tab.
 */

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactElement } from "react";

import {
  ApiFailure,
  api,
  type BrowserSession,
  type BrowserSessionDraft,
  type PublishedService,
  type PublishedServiceStatus,
  type ValidationViewport,
  type Viewport,
} from "../api/client.ts";
import { formatViewport } from "../routes/projects.tsx";
import { BROWSER_SESSION_REFUSALS, RefusalPanel } from "./refusals.tsx";

const FIELD =
  "rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";

/**
 * The value of the explicit "no route" option.
 *
 * It is not the empty string. An empty select value and an unanswered select
 * look the same to a reader and to a test, and this is a decision with a
 * consequence: a session started this way reaches nothing at all.
 */
const NO_SERVICE = "none";

/**
 * The value meaning "reserve this session for a route I have not published yet".
 *
 * It is a distinct option rather than a route identifier, because at this point
 * there is no route to name: the identifier this reservation produces is what a
 * route will be published *against*.
 */
const FOR_A_ROUTE = "reserve";

/**
 * Route statuses a session can actually be started against.
 *
 * Only `ready` is carried (`docs/DOMAIN_MODEL.md` §10). A `requested` route has
 * not been accepted by the gateway yet, and binding a session to one would fix
 * the worker's egress against an origin nothing serves.
 */
const USABLE: readonly PublishedServiceStatus[] = ["ready"];

/**
 * The two viewports every UI-facing change is validated at (`AGENTS.md`
 * "Browser-facing work", `docs/MCP_SPEC.md`). They are offered whatever the
 * project's settings say, because a project that had configured neither would
 * otherwise offer no way to reproduce a finding recorded at one of them.
 */
const REQUIRED_VIEWPORTS: readonly Viewport[] = [
  { width: 1440, height: 900, device_scale_factor: 1 },
  { width: 390, height: 844, device_scale_factor: 1 },
];

/** A viewport's label, which is also its identity within the group. */
function viewportKey(viewport: Viewport): string {
  return formatViewport(viewport);
}

/** The label as a DOM identifier: `390x844@2x` is not one. */
function viewportId(key: string): string {
  return `start-viewport-${key.replace(/[^A-Za-z0-9]+/gu, "-")}`;
}

/**
 * The presets on offer: the two required ones, then the project's own
 * validation viewports, de-duplicated. The required two come first so their
 * position does not move as a project's settings change.
 */
function presets(configured: readonly ValidationViewport[]): readonly Viewport[] {
  const seen = new Set<string>();
  const offered: Viewport[] = [];
  for (const viewport of [
    ...REQUIRED_VIEWPORTS,
    ...configured.map((entry) => ({
      width: entry.width,
      height: entry.height,
      device_scale_factor: entry.device_scale_factor ?? 1,
    })),
  ]) {
    const key = viewportKey(viewport);
    if (seen.has(key)) continue;
    seen.add(key);
    offered.push(viewport);
  }
  return offered;
}

/**
 * A failed read, by its stable code.
 *
 * A read fails for reasons the start flow's vocabulary does not describe, so
 * the refusal table is not used here. `RESOURCE_NOT_FOUND` keeps the unresolved
 * wording `docs/UX_FLOWS.md` section 18 requires; every other code is named as
 * itself.
 */
function readFailure(error: unknown, fallback: string): string {
  if (!(error instanceof ApiFailure)) return fallback;
  if (error.code === "RESOURCE_NOT_FOUND") {
    return "This does not exist, or this session is not authorised for it.";
  }
  return `${error.code}: ${error.message}`;
}

/** What starting left behind, as a sentence rather than as a state change. */
function startedSentence(session: BrowserSession): string {
  if (session.status === "REQUESTED") {
    return `Browser session ${session.id} is reserved at ${formatViewport(session.viewport)}. No browser has been opened and no worker has been contacted. Publish a route naming it, then allocate it.`;
  }
  const where =
    session.service_origin === null
      ? "It reaches no application, because no published development service was named."
      : `It reaches ${session.service_origin} over the connector's private route.`;
  return `Browser session ${session.id} is ${session.status} at ${formatViewport(session.viewport)}. ${where}`;
}

export function StartBrowserSession({ projectId }: { readonly projectId: string }): ReactElement {
  const queryClient = useQueryClient();
  const [activity, setActivity] = useState("");
  const [started, setStarted] = useState<BrowserSession | null>(null);
  const [serviceChoice, setServiceChoice] = useState<string | null>(null);
  const [viewportChoice, setViewportChoice] = useState<string | null>(null);

  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
    retry: false,
  });
  // A route's status moves after the request that created it returned, so this
  // is polled rather than read once.
  const services = useQuery({
    queryKey: ["published-services", projectId],
    queryFn: () => api.publishedServices(projectId),
    refetchInterval: 5000,
    retry: false,
  });

  const usable: readonly PublishedService[] = (services.data ?? []).filter((service) =>
    USABLE.includes(service.status),
  );
  // Two options and no route identifiers among them. The reader chooses what
  // this session is *for*; the route it reaches is named later, against the
  // reservation, because that is the only order that works.
  const chosenService = serviceChoice === FOR_A_ROUTE ? FOR_A_ROUTE : NO_SERVICE;

  /**
   * The carried routes that already name the reservation this page just made.
   *
   * A route published before the reservation existed cannot name it, so this is
   * empty until the reader has published one against it — which is what makes
   * the empty state the instruction rather than a dead end.
   */
  const reservation = started !== null && started.status === "REQUESTED" ? started : null;
  const admitting: readonly PublishedService[] =
    reservation === null
      ? []
      : usable.filter((service) => service.allowed_browser_session_ids.includes(reservation.id));

  const offered = presets(project.data?.settings.default_validation_viewports ?? []);
  const fallbackViewport: Viewport = offered[0] ?? { width: 1440, height: 900, device_scale_factor: 1 };
  const chosenViewport =
    offered.find((viewport) => viewportKey(viewport) === viewportChoice) ?? fallbackViewport;
  const chosenKey = viewportKey(chosenViewport);

  const start = useMutation({
    mutationFn: async (draft: BrowserSessionDraft) =>
      chosenService === FOR_A_ROUTE
        ? api.reserveBrowserSession(projectId, draft)
        : api.startBrowserSession(projectId, draft),
    onSuccess: async (session) => {
      setStarted(session);
      setActivity(startedSentence(session));
      await queryClient.invalidateQueries({ queryKey: ["browser-sessions", projectId] });
    },
  });

  /**
   * Admits a reservation to a route that already names it.
   *
   * The route is chosen from the routes whose `allowed_browser_session_ids`
   * contain this reservation, so the only routes offered are ones the control
   * plane will accept. A route that does not name it is refused with
   * `AUTHORISATION_DENIED` before anything is minted, and no route is ever
   * amended to make the call succeed.
   */
  const allocate = useMutation({
    mutationFn: async (input: { sessionId: string; publishedServiceId: string }) =>
      api.allocateBrowserSession(input.sessionId, input.publishedServiceId),
    onSuccess: async (session) => {
      setStarted(session);
      setActivity(startedSentence(session));
      await queryClient.invalidateQueries({ queryKey: ["browser-sessions", projectId] });
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setStarted(null);
    // No `published_service_id` on either branch. It cannot work on a
    // one-request start, because the route would have to have named a session
    // that did not exist when it was published (ADR-0037).
    start.mutate({ viewport: chosenViewport });
  }

  return (
    <section aria-labelledby="start-browser-session-heading" className="mt-6">
      <h3 id="start-browser-session-heading" className="text-lg font-semibold">
        Start a browser session
      </h3>

      {/*
        Section 6 requires the interface to state where the browser runs and how
        it reaches the application. Nothing else on this page distinguishes a
        central Chromium from a tab on the reader's own machine.
      */}
      <p
        id="start-browser-session-topology"
        className="mt-2 text-sm text-slate-700 dark:text-slate-300"
      >
        Chromium runs centrally on this ReviewPlane deployment — not in this browser and not on the
        development machine. It reaches the application over a private connector route: the
        connector dials outward from the development machine, nothing there listens publicly, and
        the session may reach only the route named below.
      </p>

      {/* Outcomes are announced here without moving focus. */}
      <p
        id="start-browser-session-activity"
        role="status"
        aria-live="polite"
        className="mt-3 text-sm text-slate-700 dark:text-slate-300"
      >
        {activity}
      </p>

      {services.isError ? (
        <p role="alert" className="mt-3 text-sm font-medium text-red-800 dark:text-red-300">
          {readFailure(services.error, "The published development services could not be read.")}
        </p>
      ) : null}

      <form className="mt-4 flex flex-col gap-5" onSubmit={submit} data-start-form={projectId}>
        <div className="flex min-w-0 flex-col gap-2 sm:max-w-xl">
          <label htmlFor="start-service" className="text-sm font-medium">
            Development service
          </label>
          <select
            id="start-service"
            name="start-service"
            value={chosenService}
            onChange={(event) => {
              setServiceChoice(event.target.value);
            }}
            // A select is sized by its longest option unless it is told
            // otherwise. At 390 px that is the difference between a page that
            // fits and one that scrolls sideways (`docs/UX_FLOWS.md` §20).
            className={`${FIELD} w-full`}
            aria-describedby="start-service-hint"
          >
            <option value={NO_SERVICE}>Nothing — start an empty browser now</option>
            <option value={FOR_A_ROUTE}>
              A development service — reserve now, publish a route, then allocate
            </option>
          </select>
          <p id="start-service-hint" className={HINT}>
            {chosenService === FOR_A_ROUTE ? (
              <span data-reserve-explanation="start-services">
                A route names the browser sessions it may carry when it is published, so it cannot
                name one that does not exist yet. This reserves the session and stops: no browser is
                opened and no worker is contacted. Publish a route against the reservation with the
                form below, then allocate it here.
              </span>
            ) : (
              <>
                The session opens immediately and reaches no application. The control plane resolves
                an origin and mints a session&apos;s capability from a route record itself, so
                neither is ever sent from this page.
              </>
            )}
          </p>
        </div>

        <fieldset className="min-w-0 border-0 p-0">
          <legend className="text-sm font-medium">Viewport preset</legend>
          <div className="mt-2 flex flex-col gap-2">
            {offered.map((viewport) => {
              const key = viewportKey(viewport);
              return (
                <label
                  key={key}
                  htmlFor={viewportId(key)}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <input
                    id={viewportId(key)}
                    name="start-viewport"
                    type="radio"
                    className="h-4 w-4"
                    value={key}
                    checked={key === chosenKey}
                    onChange={() => {
                      setViewportChoice(key);
                    }}
                  />
                  <span className="font-mono">{key}</span>
                </label>
              );
            })}
          </div>
          <p className={`mt-2 ${HINT}`}>
            1440x900 and 390x844 are always offered, because every user-interface change is
            validated at both. The rest come from this project&apos;s validation viewports.
          </p>
        </fieldset>

        {/*
          Step 3 of section 6's flow. Trace and video capture are not built at
          this stage, so the control is present, disabled and honest about why:
          omitting the step entirely would tell a reader it does not exist.
        */}
        <fieldset className="min-w-0 border-0 p-0" data-unavailable="trace-and-video">
          <legend className="text-sm font-medium">Trace and video</legend>
          <div className="mt-2 flex flex-col gap-2">
            <label htmlFor="start-trace" className="flex flex-wrap items-center gap-2 text-sm">
              <input
                id="start-trace"
                name="start-trace"
                type="checkbox"
                disabled
                checked={false}
                readOnly
                className="h-4 w-4"
                aria-describedby="start-capture-hint"
              />
              <span>Capture a Playwright trace</span>
            </label>
            <label htmlFor="start-video" className="flex flex-wrap items-center gap-2 text-sm">
              <input
                id="start-video"
                name="start-video"
                type="checkbox"
                disabled
                checked={false}
                readOnly
                className="h-4 w-4"
                aria-describedby="start-capture-hint"
              />
              <span>Record video</span>
            </label>
          </div>
          <p id="start-capture-hint" className={`mt-2 ${HINT}`}>
            Trace and video capture are not available in this stage, so both controls are disabled
            and neither is requested when a session starts. Screenshots are still captured, and they
            are what verification evidence rests on.
          </p>
        </fieldset>

        <button
          type="submit"
          id="start-submit"
          disabled={start.isPending}
          aria-describedby="start-browser-session-topology"
          className="self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
        >
          {start.isPending
            ? chosenService === FOR_A_ROUTE
              ? "Reserving…"
              : "Starting…"
            : chosenService === FOR_A_ROUTE
              ? "Reserve browser session"
              : "Start browser session"}
        </button>

        {/*
          The second half of the reserved flow, and it is deliberately on this
          page rather than elsewhere: the identifier a route has to be published
          against is the one this form has just produced, and a reader sent to
          find it somewhere else would be the reason the old select existed.
        */}
        {reservation === null ? null : (
          <div
            className="flex min-w-0 flex-col gap-2 sm:max-w-xl"
            data-reserved-session={reservation.id}
          >
            <label htmlFor="allocate-service" className="text-sm font-medium">
              Admit this reservation to a route
            </label>
            {admitting.length === 0 ? (
              <p className={HINT} data-empty="allocate-services">
                No carried route names <span className="font-mono">{reservation.id}</span> yet.
                Publish one below, choosing this reservation among the browser sessions it
                authorises, and it will be offered here. A route that does not name the reservation
                is refused before any capability is minted, and no route is amended to make an
                allocation succeed.
              </p>
            ) : (
              <>
                <select id="allocate-service" name="allocate-service" className={`${FIELD} w-full`}>
                  {admitting.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.internal_origin} → {service.protocol}://{service.local_host}:
                      {String(service.local_port)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  id="allocate-submit"
                  disabled={allocate.isPending}
                  onClick={() => {
                    const select = document.querySelector<HTMLSelectElement>("#allocate-service");
                    const chosen = select?.value ?? admitting[0]?.id;
                    if (chosen === undefined) return;
                    allocate.mutate({ sessionId: reservation.id, publishedServiceId: chosen });
                  }}
                  className="self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
                >
                  {allocate.isPending ? "Allocating…" : "Allocate browser session"}
                </button>
              </>
            )}
          </div>
        )}

        {started === null || started.status === "REQUESTED" ? null : (
          <p className="text-sm" data-started-session={started.id}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: started.id }}
              className="underline underline-offset-4"
            >
              Open the session room
            </Link>
          </p>
        )}

        {allocate.error === null ? null : (
          <RefusalPanel
            code={allocate.error instanceof ApiFailure ? allocate.error.code : "INTERNAL_ERROR"}
            message={
              allocate.error instanceof ApiFailure
                ? allocate.error.message
                : "The browser session could not be allocated."
            }
            attribute="data-failure"
            table={BROWSER_SESSION_REFUSALS}
            surface="allocate-browser-session"
          />
        )}

        {start.error === null ? null : (
          <RefusalPanel
            code={start.error instanceof ApiFailure ? start.error.code : "INTERNAL_ERROR"}
            message={
              start.error instanceof ApiFailure
                ? start.error.message
                : "The browser session could not be started."
            }
            attribute="data-refusal"
            table={BROWSER_SESSION_REFUSALS}
            surface="start-browser-session"
          />
        )}
      </form>
    </section>
  );
}
