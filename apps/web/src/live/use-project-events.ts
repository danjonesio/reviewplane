/**
 * The project event stream, as React sees it.
 *
 * The hook exists so that the sequence bookkeeping stays in one place. Two
 * things feed the same history and they must not fight:
 *
 *   1. `GET /api/v1/projects/:projectId/activity`, which is the durable record
 *      and is what a client refetches from (`docs/API.md` section 18.1);
 *   2. `/ws/v1/projects/:projectId/events`, which is live delivery.
 *
 * The rule is that HTTP seeds and the socket extends. The socket is not opened
 * until the seed has landed, because a socket opened at sequence zero would ask
 * the server to replay a project's entire history to build a panel that shows
 * the last two hundred rows. When the server answers `stream.refresh_required`
 * the same seed runs again — that is the whole of the refresh handling, and it
 * is why the instruction is not an error: the reader ends up with a history read
 * from the record rather than a history with a hole in it.
 *
 * Rows are merged by event identifier and ordered by sequence, so a resume that
 * overlaps repeats nothing and a delivery that arrives out of order still reads
 * in order.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { StreamRefreshRequiredReason } from "@reviewplane/protocol/platform";

import { api, eventsUrl, type ActivityEvent } from "../api/client.ts";
import {
  ProjectEventClient,
  type EventStreamFailure,
  type EventStreamStatus,
  type StreamedEvent,
} from "./events.ts";
import { mergeEntry, toTimelineEntry, type TimelineEntry } from "./timeline.ts";

/** How much history the panel seeds with. The record holds the rest. */
export const SEED_EVENT_COUNT = 100;

export interface RefreshNotice {
  readonly reason: StreamRefreshRequiredReason;
  readonly at: number;
}

export interface ProjectEventsState {
  readonly status: EventStreamStatus;
  readonly failure: EventStreamFailure | null;
  readonly entries: readonly TimelineEntry[];
  /** Set while the server has told this client to refetch, cleared once it has. */
  readonly refresh: RefreshNotice | null;
  /** True while the seed is still loading, so a surface can say so. */
  readonly seeding: boolean;
  /** The seed failed. Its stable code, for the refusal table. */
  readonly seedError: string | null;
  readonly lastSequence: number;
}

function toStreamed(event: ActivityEvent): StreamedEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    occurred_at: event.occurred_at,
    actor: event.actor,
    correlation: {},
    payload: event.payload,
  };
}

/**
 * Subscribes to a project's events and keeps a bounded, ordered history.
 *
 * `filter` narrows what reaches the history without narrowing what is
 * acknowledged: the session room shows one session's rows, but the sequence it
 * resumes from is the stream's, not the filtered subset's. Acknowledging only
 * what passed the filter would make a reconnect replay everything the filter
 * rejected, every time.
 */
export function useProjectEvents(
  projectId: string | undefined,
  options?: {
    readonly filter?: (event: StreamedEvent) => boolean;
    readonly enabled?: boolean;
  },
): ProjectEventsState {
  const enabled = (options?.enabled ?? true) && projectId !== undefined;
  const filter = options?.filter;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const [entries, setEntries] = useState<readonly TimelineEntry[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>("connecting");
  const [failure, setFailure] = useState<EventStreamFailure | null>(null);
  const [refresh, setRefresh] = useState<RefreshNotice | null>(null);
  const [lastSequence, setLastSequence] = useState(0);
  /** Bumped to force the seed to run again after a refresh instruction. */
  const [generation, setGeneration] = useState(0);
  /**
   * The position a socket is opened at, held in a ref as well as in state.
   *
   * The state is what the surface displays and changes on every event; the ref
   * is what the effect reads. Reading the state there would make the position a
   * dependency of the socket's lifetime, and a socket that reopened on every
   * event would replay its way into a loop.
   */
  const startAtRef = useRef(0);

  const seed = useQuery({
    queryKey: ["activity", projectId, generation],
    queryFn: () => api.activity(projectId ?? "", SEED_EVENT_COUNT),
    enabled,
    retry: 1,
  });

  const apply = useCallback((event: StreamedEvent) => {
    if (filterRef.current?.(event) === false) return;
    setEntries((history) => mergeEntry(history, toTimelineEntry(event)));
  }, []);

  // The seed replaces the history rather than merging into it: after a refresh
  // instruction the record is authoritative and the rows this client was
  // holding may straddle a gap.
  useEffect(() => {
    if (seed.data === undefined) return;
    const admitted = seed.data
      .map((event) => toStreamed(event))
      .filter((event) => filterRef.current?.(event) ?? true);
    setEntries(
      admitted
        .map((event) => toTimelineEntry(event))
        .sort((left, right) => right.sequence - left.sequence),
    );
    // The resume point is the stream's highest sequence, not the highest that
    // survived the filter.
    const highest = seed.data.reduce((max, event) => Math.max(max, event.sequence), 0);
    startAtRef.current = highest;
    setLastSequence(highest);
  }, [seed.data]);

  const seeded = seed.data !== undefined;

  useEffect(() => {
    if (!enabled || projectId === undefined || !seeded) return;
    const client = new ProjectEventClient({
      url: eventsUrl(projectId),
      lastSequence: startAtRef.current,
      events: {
        onStatus: (next, nextFailure) => {
          setStatus(next);
          setFailure(nextFailure);
        },
        onEvent: (event) => {
          startAtRef.current = Math.max(startAtRef.current, event.sequence);
          setLastSequence((current) => Math.max(current, event.sequence));
          apply(event);
        },
        onRefreshRequired: (reason, currentSequence) => {
          startAtRef.current = currentSequence;
          setLastSequence(currentSequence);
          setRefresh({ reason, at: Date.now() });
          // Refetch state from the record, which is what the instruction asks
          // for. Live delivery has already resumed from `currentSequence`.
          setGeneration((value) => value + 1);
        },
      },
    });
    client.connect();
    return () => {
      client.close();
    };
  }, [enabled, projectId, seeded, generation, apply]);

  return {
    status,
    failure,
    entries,
    refresh,
    seeding: seed.isPending && enabled,
    seedError: seed.isError ? errorCode(seed.error) : null,
    lastSequence,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "INTERNAL_ERROR";
}
