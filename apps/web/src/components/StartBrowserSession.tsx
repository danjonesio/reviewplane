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
  // The choice is the reader's where they made one and the first usable route
  // until they do, so nothing has to be synchronised into state as the list
  // arrives. A choice whose route has since been revoked falls back the same
  // way, rather than leaving the select showing a value it no longer offers.
  const offeredService =
    serviceChoice === NO_SERVICE
      ? NO_SERVICE
      : usable.find((service) => service.id === serviceChoice)?.id;
  const chosenService = offeredService ?? usable[0]?.id ?? NO_SERVICE;

  const offered = presets(project.data?.settings.default_validation_viewports ?? []);
  const fallbackViewport: Viewport = offered[0] ?? { width: 1440, height: 900, device_scale_factor: 1 };
  const chosenViewport =
    offered.find((viewport) => viewportKey(viewport) === viewportChoice) ?? fallbackViewport;
  const chosenKey = viewportKey(chosenViewport);

  const start = useMutation({
    mutationFn: async (draft: BrowserSessionDraft) => api.startBrowserSession(projectId, draft),
    onSuccess: async (session) => {
      setStarted(session);
      setActivity(startedSentence(session));
      await queryClient.invalidateQueries({ queryKey: ["browser-sessions", projectId] });
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setStarted(null);
    start.mutate({
      viewport: chosenViewport,
      ...(chosenService === NO_SERVICE ? {} : { published_service_id: chosenService }),
    });
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
            // otherwise, and a route's origin is long. At 390 px that is the
            // difference between a page that fits and one that scrolls
            // sideways (`docs/UX_FLOWS.md` section 20).
            className={`${FIELD} w-full`}
            aria-describedby="start-service-hint"
          >
            {usable.map((service) => (
              <option key={service.id} value={service.id}>
                {service.internal_origin} → {service.protocol}://{service.local_host}:
                {String(service.local_port)}
              </option>
            ))}
            <option value={NO_SERVICE}>No published service (the session will reach nothing)</option>
          </select>
          <p id="start-service-hint" className={HINT}>
            {usable.length === 0 ? (
              <span data-empty="start-services">
                This project carries no published development service, so the only choice is a
                session that reaches nothing. Publish one below first if the browser is meant to
                open an application.
              </span>
            ) : (
              <>
                Only a carried route is offered; a route still being accepted by the gateway is not.
                The control plane resolves the origin and mints the session&apos;s capability from
                the record itself — neither is sent from this page.
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
          {start.isPending ? "Starting…" : "Start browser session"}
        </button>

        {started === null ? null : (
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
