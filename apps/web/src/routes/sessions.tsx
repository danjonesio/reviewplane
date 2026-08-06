/**
 * The fleet dashboard (`docs/UX_FLOWS.md` section 3).
 *
 * Purpose, in section 3's words: answer "what are my agents and browsers doing
 * now?" A card per running session, each carrying the ten facts that section
 * lists, and the actions Stage 1 can honestly offer.
 *
 * **Take control is not offered.** Section 3 lists it and Stage 2 delivers it:
 * the control WebSocket, pointer and keyboard input and the "you are
 * controlling this browser" state are not built. A button that could not take
 * control would be worse than its absence, because a reader who believed they
 * held input authority would act on that belief.
 *
 * Every query here reads through the project-scoped API, so what a card shows is
 * decided by the control plane. Navigation reflects authorisation; it never
 * grants it (`docs/SECURITY.md` section 7).
 *
 * Reads are per project and not per card. Twenty cards in one project ask for
 * the project's reviews once between them; a card that fetched its own would
 * multiply the same answer by the number of browsers running.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactElement } from "react";

import {
  ApiFailure,
  api,
  isActive,
  type BrowserSession,
  type EnvironmentRecord,
  type Project,
  type PublishedService,
  type Review,
} from "../api/client.ts";
import { useSession } from "../auth/session.ts";
import { BROWSER_SESSION_REFUSALS, RefusalPanel } from "../components/refusals.tsx";
import {
  SessionCard,
  type SessionCardCounts,
  type SessionCardEnvironment,
} from "../components/SessionCard.tsx";
import { toTimelineEntry, type TimelineEntry } from "../live/timeline.ts";
import type { StreamedEvent } from "../live/events.ts";
import { rootRoute } from "./root.tsx";

/** How much history a card's "last meaningful event" is chosen from. */
const CARD_EVENT_WINDOW = 25;

/** Review statuses that are neither accepted, cancelled nor archived. */
const OPEN_REVIEW_STATUSES: readonly string[] = [
  "DRAFT",
  "READY",
  "ASSIGNED",
  "IN_PROGRESS",
  "AWAITING_HUMAN_REVIEW",
  "CHANGES_REQUESTED",
];

interface ProjectContext {
  readonly reviews: SessionCardCounts | undefined;
  readonly lastEvent: TimelineEntry | undefined;
  readonly lastAgentAction: TimelineEntry | undefined;
  readonly environments: readonly EnvironmentRecord[];
  readonly services: readonly PublishedService[];
}

function countReviews(reviews: readonly Review[] | undefined): SessionCardCounts | undefined {
  if (reviews === undefined) return undefined;
  return {
    awaitingHuman: reviews.filter((review) => review.status === "AWAITING_HUMAN_REVIEW").length,
    open: reviews.filter((review) => OPEN_REVIEW_STATUSES.includes(review.status)).length,
  };
}

/**
 * Which environment and checkout a session's application comes from.
 *
 * A session reaches an application through a published route and nothing else,
 * so the route is the only honest link between a browser and a checkout: the
 * route names a workspace, and the environment that reported that workspace is
 * the environment the session is attached to. Guessing from the project would
 * name the wrong machine whenever a project has two.
 */
function environmentFor(
  session: BrowserSession,
  context: ProjectContext | undefined,
): SessionCardEnvironment | undefined {
  if (context === undefined || session.published_service_id === null) return undefined;
  const service = context.services.find((entry) => entry.id === session.published_service_id);
  if (service === undefined) return undefined;
  for (const environment of context.environments) {
    const workspace = environment.workspaces.find((entry) => entry.id === service.workspace_id);
    if (workspace !== undefined) return { name: environment.name, workspace };
  }
  return undefined;
}

function Sessions(): ReactElement {
  // The shell has already established that somebody is signed in; this page
  // reads the same session rather than asking again, so a sign-out clears every
  // surface at once.
  const session = useSession();
  const [activity, setActivity] = useState("");
  const [busy, setBusy] = useState<{ id: string; action: "pause" | "end" } | null>(null);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects(),
    enabled: session.data !== undefined,
  });
  const projectIds = useMemo(
    () => (projects.data ?? []).map((project) => project.id),
    [projects.data],
  );

  const sessionQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["browser-sessions", projectId],
      queryFn: () => api.browserSessions(projectId),
      // A restarted control plane must not leave a stale list behind: the list
      // refreshes on its own and on every window focus.
      refetchInterval: 5000,
    })),
  });
  const reviewQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["reviews", projectId],
      queryFn: () => api.reviews(projectId),
    })),
  });
  const activityQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["activity", projectId, "fleet"],
      queryFn: () => api.activity(projectId, CARD_EVENT_WINDOW),
      refetchInterval: 10000,
    })),
  });
  const environmentQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["environments", projectId],
      queryFn: () => api.environments(projectId),
    })),
  });
  const serviceQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["published-services", projectId],
      queryFn: () => api.publishedServices(projectId),
    })),
  });

  const contexts = useMemo(() => {
    const map = new Map<string, ProjectContext>();
    projectIds.forEach((projectId, index) => {
      const events = (activityQueries[index]?.data ?? []).map((event) =>
        toTimelineEntry({
          id: event.id,
          sequence: event.sequence,
          type: event.type,
          occurred_at: event.occurred_at,
          actor: event.actor,
          correlation: {},
          payload: event.payload,
        } satisfies StreamedEvent),
      );
      const ordered = [...events].sort((left, right) => right.sequence - left.sequence);
      map.set(projectId, {
        reviews: countReviews(reviewQueries[index]?.data),
        lastEvent: ordered[0],
        lastAgentAction: ordered.find((entry) => entry.category === "agent_action"),
        environments: environmentQueries[index]?.data ?? [],
        services: serviceQueries[index]?.data ?? [],
      });
    });
    return map;
    // The query arrays are rebuilt on every render by `useQueries`, so their
    // identities are not usable as dependencies; their data is what matters and
    // is compared through the values read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectIds,
    activityQueries.map((query) => query.dataUpdatedAt).join(),
    reviewQueries.map((query) => query.dataUpdatedAt).join(),
    environmentQueries.map((query) => query.dataUpdatedAt).join(),
    serviceQueries.map((query) => query.dataUpdatedAt).join(),
  ]);

  const control = useMutation({
    mutationFn: async (input: { session: BrowserSession; action: "pause" | "end" }) => {
      const epoch = input.session.control_epoch;
      return input.action === "pause"
        ? api.pauseBrowserSession(input.session.id, epoch)
        : api.terminateBrowserSession(input.session.id, epoch);
    },
    onMutate: (input) => {
      setBusy({ id: input.session.id, action: input.action });
    },
    onSuccess: async (record, input) => {
      setActivity(
        `The browser session was ${input.action === "pause" ? "paused" : "ended"}. It is now ${record.status}, at control epoch ${String(record.control_epoch)}.`,
      );
      setBusy(null);
      await Promise.all(sessionQueries.map(async (query) => query.refetch()));
    },
    onError: async () => {
      setBusy(null);
      // A refused epoch means control moved. Reading the list again is what
      // stops the reader retrying against a number that is already stale.
      await Promise.all(sessionQueries.map(async (query) => query.refetch()));
    },
  });

  if (session.isPending) return <p role="status">Loading.</p>;

  const byProject = new Map<string, Project>(
    (projects.data ?? []).map((project) => [project.id, project]),
  );
  const sessions = sessionQueries
    .flatMap((query) => query.data ?? [])
    .filter((browserSession) => isActive(browserSession))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));

  const environmentsKnown = environmentQueries.some((query) => (query.data ?? []).length > 0);
  const environmentsRead = environmentQueries.every((query) => query.isSuccess);

  return (
    <section aria-labelledby="sessions-heading">
      <h1 id="sessions-heading" className="text-xl font-semibold">
        Live sessions
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Signed in as {session.data?.user?.email ?? session.data?.session.display ?? "this session"}.
        Chromium runs centrally in this deployment; each session reaches its application through a
        private connector route, never through your browser.
      </p>
      {/*
        Section 3 lists Take control among the card actions. Saying why it is
        absent is not an apology: a reader who cannot see the action needs to
        know whether it is missing or merely elsewhere.
      */}
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
        Watching is read-only at this stage. Taking interactive control of a browser is not offered
        yet, so nothing here types into a session; each card shows which controller holds the
        browser.
      </p>

      {/* Outcomes are announced without moving focus. */}
      <p
        id="fleet-activity"
        role="status"
        aria-live="polite"
        className="mt-2 text-sm text-slate-700 dark:text-slate-300"
      >
        {activity}
      </p>

      {control.error === null || control.error === undefined ? null : (
        <RefusalPanel
          code={control.error instanceof ApiFailure ? control.error.code : "INTERNAL_ERROR"}
          message={
            control.error instanceof ApiFailure
              ? control.error.message
              : "The browser session could not be changed."
          }
          attribute="data-refusal"
          table={BROWSER_SESSION_REFUSALS}
          surface="fleet-control"
        />
      )}

      {projects.isPending ? <p role="status">Loading projects.</p> : null}

      {/*
        The named empty state of `docs/UX_FLOWS.md` section 18: a deployment with
        no environment has nothing to publish, so a browser session would have
        nothing to open. It says why there is nothing here and offers the
        enrolment flow rather than leaving the reader to find it.
      */}
      {environmentsRead && !environmentsKnown && !projects.isPending ? (
        <div
          data-empty-state="no-connector"
          className="mt-6 rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
        >
          <h2 className="text-base font-semibold">No connector is connected</h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            Nothing is broken. No development environment has enrolled a connector yet, so there is
            no application to publish and a browser session would have nothing to open. Enrol a
            connector on the machine your development server runs on, then publish the port.
          </p>
          {projectIds[0] === undefined ? null : (
            <p className="mt-3">
              <Link
                to="/projects/$projectId/environments"
                params={{ projectId: projectIds[0] }}
                className="inline-block rounded border border-slate-400 px-3 py-2 text-sm font-medium dark:border-slate-600"
              >
                Enrol a connector
              </Link>
            </p>
          )}
        </div>
      ) : null}

      {sessions.length === 0 && !projects.isPending ? (
        <div
          data-empty-state="no-sessions"
          className="mt-6 rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
        >
          <h2 className="text-base font-semibold">No browser session is running</h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            A session appears here as soon as an agent or an operator starts one. Nothing is wrong:
            this list is empty because no browser has been allocated yet.
          </p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {sessions.map((browserSession) => (
            <SessionCard
              key={browserSession.id}
              session={browserSession}
              project={byProject.get(browserSession.project_id)}
              environment={environmentFor(
                browserSession,
                contexts.get(browserSession.project_id),
              )}
              counts={contexts.get(browserSession.project_id)?.reviews}
              lastEvent={contexts.get(browserSession.project_id)?.lastEvent}
              lastAgentAction={contexts.get(browserSession.project_id)?.lastAgentAction}
              onPause={(target) => {
                control.mutate({ session: target, action: "pause" });
              }}
              onEnd={(target) => {
                control.mutate({ session: target, action: "end" });
              }}
              busy={busy?.id === browserSession.id ? busy.action : null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Sessions,
});
