/**
 * The signed-in human, as the application asks about them.
 *
 * One query key, so every surface reads the same session and a sign-out
 * invalidates all of them at once. `retry: false` matters: a 401 is the
 * ordinary answer for a page that has not signed in yet, and retrying it three
 * times would put three console errors on the first-run screen.
 */

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client.ts";
import type { BootstrapStatus, CurrentSession } from "../api/client.ts";

export const SESSION_QUERY_KEY = ["session"] as const;
export const BOOTSTRAP_QUERY_KEY = ["bootstrap-status"] as const;

export function useSession(): UseQueryResult<CurrentSession> {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => api.currentSession(),
    retry: false,
  });
}

/**
 * Whether this installation is still unclaimed.
 *
 * Only asked when there is no session: a signed-in deployment is a claimed one
 * by definition, and asking anyway would be a request every page made for an
 * answer it already has.
 */
export function useBootstrapStatus(enabled: boolean): UseQueryResult<BootstrapStatus> {
  return useQuery({
    queryKey: BOOTSTRAP_QUERY_KEY,
    queryFn: () => api.bootstrapStatus(),
    enabled,
    retry: false,
  });
}
