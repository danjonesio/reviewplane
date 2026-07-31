/**
 * Environments, connector enrolment and connector health (`docs/UX_FLOWS.md`
 * sections 5 and 18, `docs/API.md` section 9, `docs/DOMAIN_MODEL.md` sections 7
 * to 9).
 *
 * Three surfaces, all inside the project that owns them, because
 * `docs/UX_FLOWS.md` section 2.1 puts connectors there rather than in a primary
 * navigation entry of their own:
 *
 * ```text
 * Environments                       what is connected, and how healthy it is
 * Environments / Enrol               mint a token and watch the machine arrive
 * Environments / Connectors / :id    one connector's whole record
 * ```
 *
 * Two properties drive the design. The enrolment token is a credential shown
 * exactly once — the control plane keeps a digest and cannot reproduce it — so
 * the page says so before it is scrolled past, and getting the command out of
 * the page must work by keyboard even where the clipboard is refused.
 * Revocation is terminal — a revoked identity is refused before a channel is
 * established, and re-enrolment creates a new one — so it is a two-step action
 * that states its consequences in words and reports what it actually did.
 *
 * Everything a connector reports about the machine it runs on is description,
 * never an authorisation input, and it is rendered as text rather than as
 * anything the reporting machine could aim (ADR-0010).
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

import {
  ApiFailure,
  api,
  type ConnectorRevocation,
  type ConnectorStatus,
  type ConnectorSummary,
  type EnrolmentToken,
  type EnvironmentRecord,
  type WorkspaceSummary,
} from "../api/client.ts";
import { WorkspaceFacts } from "../components/GitContext.tsx";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { projectRoute } from "./project.tsx";

const FIELD =
  "rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const CARD =
  "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";

const TONE_FOR_CONNECTOR: Readonly<Record<ConnectorStatus, Tone>> = {
  PENDING_ENROLMENT: "waiting",
  ACTIVE: "live",
  DEGRADED: "warning",
  DISCONNECTED: "failed",
  REVOKED: "failed",
};

/**
 * The status as a sentence a person can act on. The badge already carries the
 * status word, so colour is never the only signal (`docs/UX_FLOWS.md` section
 * 19); this is what the word means.
 */
const CONNECTOR_HEALTH: Readonly<Record<ConnectorStatus, string>> = {
  PENDING_ENROLMENT: "waiting for the connector to dial out",
  ACTIVE: "connected and answering heartbeats",
  DEGRADED: "connected, but heartbeats are late",
  DISCONNECTED: "no heartbeat, and no open channel",
  REVOKED: "revoked, and this identity is refused",
};

/** Lifetimes worth offering. Shorter is safer: the token is a credential. */
const EXPIRY_CHOICES: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: 900, label: "15 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 14_400, label: "4 hours" },
  { seconds: 86_400, label: "24 hours" },
];

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** Whether the control plane knows this value at all. */
function known<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * An absolute instant, or an em dash where the record has none. Absence
 * arrives as `null` from the API and as an absent member in the schema, and
 * `new Date(null)` is 1970 rather than an error, so both are checked.
 */
function instant(value: string | null | undefined): string {
  return known(value) ? new Date(value).toLocaleString() : "—";
}

/**
 * "in 60 minutes", beside the absolute time rather than instead of it. An
 * absolute time is unambiguous; a relative one is what a person reading an
 * expiry actually wants to know.
 */
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

function describeWorkspace(workspace: WorkspaceSummary | undefined): string {
  if (workspace === undefined) return "none reported yet";
  return `${workspace.display_path} on ${workspace.branch}`;
}

/** The refusal, by its stable code, never as "something went wrong". */
function failureText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiFailure)) return fallback;
  if (error.code === "RESOURCE_NOT_FOUND") {
    return "This does not exist, or this session is not authorised for it.";
  }
  return `${error.code}: ${error.message}`;
}

/**
 * Revocation, as a deliberate two-step action.
 *
 * The confirmation states the consequences in words rather than relying on a
 * red button to imply them, and the outcome is reported through the surface's
 * live region: a person who cannot see the list change still learns what
 * revoking did.
 */
function RevokeConnector({
  connector,
  onOutcome,
}: {
  readonly connector: ConnectorSummary;
  readonly onOutcome: (outcome: ConnectorRevocation) => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const revoke = useMutation({
    mutationFn: async () => api.revokeConnector(connector.id),
    onSuccess: async (outcome) => {
      setConfirming(false);
      onOutcome(outcome);
      await queryClient.invalidateQueries({ queryKey: ["environments"] });
      await queryClient.invalidateQueries({ queryKey: ["connectors"] });
      await queryClient.invalidateQueries({ queryKey: ["connector", connector.id] });
    },
  });

  // Opening the confirmation moves focus to the destructive control, so a
  // keyboard user does not have to hunt for the panel that just appeared.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (connector.status === "REVOKED") {
    return (
      <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
        This identity is revoked. Re-enrolling the machine creates a new connector.
      </p>
    );
  }

  if (!confirming) {
    return (
      <p className="mt-3">
        <button
          type="button"
          data-revoke={connector.id}
          onClick={() => {
            setConfirming(true);
          }}
          className="rounded border border-red-700 px-3 py-2 text-sm font-medium text-red-800 dark:border-red-500 dark:text-red-300"
        >
          Revoke connector
        </button>
      </p>
    );
  }

  return (
    <div className="mt-3 rounded border-2 border-red-700 p-3 dark:border-red-500">
      <p className="text-sm font-semibold text-red-800 dark:text-red-300">
        Revoke this connector?
      </p>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Revoking closes every channel this connector holds, revokes the routes it published, and
        marks the browser sessions that reached this environment disconnected. It cannot be
        undone: re-enrolling this machine creates a new connector identity, and the current one is
        refused before a channel is established.
      </p>
      <p className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          ref={confirmRef}
          data-revoke-confirm={connector.id}
          disabled={revoke.isPending}
          onClick={() => {
            revoke.mutate();
          }}
          className="rounded bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60"
        >
          {revoke.isPending ? "Revoking…" : "Yes, revoke this connector"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
          }}
          className="rounded border border-slate-400 px-3 py-2 text-sm font-medium dark:border-slate-600"
        >
          Keep the connector
        </button>
      </p>
      {revoke.error === null ? null : (
        <p role="alert" className="mt-3 text-sm font-medium text-red-800 dark:text-red-300">
          {failureText(revoke.error, "The connector could not be revoked.")}
        </p>
      )}
    </div>
  );
}

/** One connector's health, as text before it is anything else. */
function ConnectorPanel({
  connector,
  projectId,
  onOutcome,
}: {
  readonly connector: ConnectorSummary;
  readonly projectId: string;
  readonly onOutcome: (outcome: ConnectorRevocation) => void;
}): ReactElement {
  return (
    <div className={CARD} data-connector={connector.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h4 className="min-w-0 break-all font-mono text-sm font-semibold">{connector.id}</h4>
        <StatusBadge
          tone={TONE_FOR_CONNECTOR[connector.status] ?? "neutral"}
          label={connector.status}
          detail={CONNECTOR_HEALTH[connector.status] ?? "status unknown"}
        />
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Version</dt>
          <dd className="font-mono">{connector.version}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Capabilities</dt>
          <dd className="break-words font-mono">
            {connector.capabilities.length === 0 ? "none declared" : connector.capabilities.join(", ")}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-slate-600 dark:text-slate-400">Certificate fingerprint</dt>
          <dd className="break-all font-mono text-xs">{connector.certificate_fingerprint}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Connected</dt>
          <dd>{instant(connector.connected_at)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Last heartbeat</dt>
          <dd>{instant(connector.last_heartbeat_at)}</dd>
        </div>
        {!known(connector.revoked_at) ? null : (
          <div className="min-w-0">
            <dt className="text-slate-600 dark:text-slate-400">Revoked</dt>
            <dd>{instant(connector.revoked_at)}</dd>
          </div>
        )}
      </dl>
      <p className="mt-3 text-sm">
        <Link
          to="/projects/$projectId/environments/connectors/$connectorId"
          params={{ projectId, connectorId: connector.id }}
          className="underline underline-offset-4"
        >
          Connector details
        </Link>
      </p>
      <RevokeConnector connector={connector} onOutcome={onOutcome} />
    </div>
  );
}

function EnvironmentCard({
  environment,
  projectId,
  onOutcome,
}: {
  readonly environment: EnvironmentRecord;
  readonly projectId: string;
  readonly onOutcome: (outcome: ConnectorRevocation) => void;
}): ReactElement {
  return (
    <li className={CARD} data-environment={environment.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-base font-semibold">{environment.name}</h3>
        <StatusBadge
          tone="neutral"
          label={environment.status}
          detail={`${environment.trust_level} trust`}
        />
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Platform</dt>
          <dd className="font-mono">
            {environment.platform}/{environment.architecture}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Labels</dt>
          <dd className="break-words font-mono">
            {environment.labels.length === 0 ? "none" : environment.labels.join(", ")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Last seen</dt>
          <dd>{instant(environment.last_seen_at)}</dd>
        </div>
      </dl>

      <h4 className="mt-5 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
        Connectors
      </h4>
      {environment.connectors.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          No connector has enrolled into this environment yet.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {environment.connectors.map((connector) => (
            <ConnectorPanel
              key={connector.id}
              connector={connector}
              projectId={projectId}
              onOutcome={onOutcome}
            />
          ))}
        </div>
      )}

      <h4 className="mt-5 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
        Authorised workspaces
      </h4>
      {environment.workspaces.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          No checkout has been reported from this environment yet.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {environment.workspaces.map((workspace) => (
            <div key={workspace.id} className="rounded border border-slate-200 p-3 dark:border-slate-800">
              <WorkspaceFacts workspace={workspace} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** The report a revocation leaves in the live region. */
function revocationSentence(outcome: ConnectorRevocation): string {
  const routes = `${String(outcome.routes_revoked)} ${outcome.routes_revoked === 1 ? "route" : "routes"}`;
  const sessions = `${String(outcome.sessions_disconnected)} ${
    outcome.sessions_disconnected === 1 ? "browser session" : "browser sessions"
  }`;
  const channels = `${String(outcome.channels_closed)} ${
    outcome.channels_closed === 1 ? "channel" : "channels"
  }`;
  // The credentials are named because they are the effect an operator cannot
  // see anywhere else on this screen: a route and a session have their own rows,
  // and a credential the connector minted for a local agent has none.
  const credentials = `${String(outcome.agent_credentials_revoked)} agent ${
    outcome.agent_credentials_revoked === 1 ? "credential" : "credentials"
  }`;
  return `Connector ${outcome.id} is revoked. ${routes} revoked, ${sessions} disconnected, ${channels} closed, ${credentials} revoked. Re-enrolling the machine creates a new identity.`;
}

function ProjectEnvironments(): ReactElement {
  const { projectId } = projectRoute.useParams();
  const [activity, setActivity] = useState("");
  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api.environments(projectId),
    // An environment appears the moment a connector finishes enrolling, which
    // is a thing that happens on another machine while this page is open.
    refetchInterval: 5000,
    retry: false,
  });

  const records = environments.data ?? [];

  return (
    <section aria-labelledby="project-environments-heading">
      <h2 id="project-environments-heading" className="text-lg font-semibold">
        Environments
      </h2>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        A development environment reaches this project through a connector, which dials out from
        the machine your application runs on. Nothing listens on that machine.
      </p>
      <p className="mt-4">
        <Link
          to="/projects/$projectId/environments/enrol"
          params={{ projectId }}
          className="inline-block rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
        >
          Enrol a connector
        </Link>
      </p>

      {/* Revocation and other outcomes are announced here without moving focus. */}
      <p
        id="environments-activity"
        role="status"
        aria-live="polite"
        className="mt-4 text-sm text-slate-700 dark:text-slate-300"
      >
        {activity}
      </p>

      {environments.isPending ? <p role="status">Loading the environments.</p> : null}

      {environments.isError ? (
        <p role="alert" className="mt-4 text-sm font-medium text-red-800 dark:text-red-300">
          {failureText(environments.error, "The environments could not be read.")}
        </p>
      ) : null}

      {!environments.isPending && !environments.isError && records.length === 0 ? (
        <div className={`mt-6 ${CARD}`} data-empty="environments">
          <h3 className="text-base font-semibold">No connector is connected</h3>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            This project has no development environment, because no connector has enrolled into
            it yet. Until one does there is nothing to publish, so a browser session has no
            application to open.
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
        </div>
      ) : null}

      {records.length === 0 ? null : (
        <ul className="mt-6 flex flex-col gap-4">
          {records.map((environment) => (
            <EnvironmentCard
              key={environment.id}
              environment={environment}
              projectId={projectId}
              onOutcome={(outcome) => {
                setActivity(revocationSentence(outcome));
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The issued token, and the only sight of it there will ever be.
 *
 * Copying is a button, and it is also possible without one: the command block
 * is focusable and selectable, and a refused clipboard falls back to selecting
 * it and saying so. A page whose only route out was a clipboard the browser
 * declined would be a page a keyboard user could not finish.
 */
function IssuedToken({
  token,
  scopeLabel,
}: {
  readonly token: EnrolmentToken;
  readonly scopeLabel: string;
}): ReactElement {
  const [copyOutcome, setCopyOutcome] = useState("");

  function selectCommand(): boolean {
    const node = document.getElementById("enrolment-command");
    const selection = globalThis.getSelection();
    if (node === null || selection === null) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    node.focus();
    return true;
  }

  async function copyCommand(): Promise<void> {
    // Not every browser exposes the clipboard, and one that does may still
    // refuse the write; neither is the reader's mistake.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard !== undefined) {
      try {
        await clipboard.writeText(token.connector_command);
        setCopyOutcome("The command is on the clipboard. This is the only copy of the token.");
        return;
      } catch {
        // Falls through to selecting it instead.
      }
    }
    setCopyOutcome(
      selectCommand()
        ? "This browser did not allow copying. The command is selected: press Ctrl+C, or Cmd+C on macOS."
        : "This browser did not allow copying. Select the command above and copy it manually.",
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="rounded border-2 border-amber-600 bg-amber-50 p-4 dark:bg-amber-950/40">
        <h3 className="text-base font-semibold text-amber-900 dark:text-amber-200">
          This token is shown once
        </h3>
        <p className="mt-2 text-sm text-amber-900 dark:text-amber-100">
          It cannot be retrieved again. The control plane stores only its digest, so no
          administrator and no support request can produce it a second time. Copy it now; if it is
          lost, mint another and this one expires unused.
        </p>
      </div>

      <div>
        <h3 className="text-base font-semibold">Run this on the development machine</h3>
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          The command reads the token from the file it names, rather than taking it as an
          argument: a command line appears in the process table and in shell history. Write the
          token below into that file first, readable only by its owner.
        </p>
        {/*
          Focusable and selectable, so the command can be copied by hand when the
          clipboard is unavailable. The value is the control plane's own
          assembled command and is rendered as text.
        */}
        <pre
          id="enrolment-command"
          tabIndex={0}
          aria-label="Connector enrolment command"
          className="mt-3 max-w-full overflow-x-auto rounded border border-slate-300 bg-slate-50 p-4 text-xs dark:border-slate-700 dark:bg-slate-950"
        >
          <code>{token.connector_command}</code>
        </pre>
        <p className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            id="copy-enrolment-command"
            onClick={() => {
              void copyCommand();
            }}
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
          >
            Copy command
          </button>
          <span className={HINT}>
            Or focus the command and copy it with the keyboard: it is selectable text.
          </span>
        </p>
        <p
          id="enrolment-copy-status"
          role="status"
          aria-live="polite"
          className="mt-2 text-sm text-slate-700 dark:text-slate-300"
        >
          {copyOutcome}
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Expires</dt>
          <dd id="enrolment-expiry">
            {new Date(token.expires_at).toLocaleString()} ({relativeToNow(token.expires_at)})
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Project scope</dt>
          <dd id="enrolment-scope" className="break-words">
            {scopeLabel}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Expected environment labels</dt>
          <dd id="enrolment-labels" className="break-words font-mono">
            {token.environment_labels.length === 0
              ? "any labels; this token pins none"
              : token.environment_labels.join(", ")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Uses</dt>
          <dd>
            {String(token.max_uses)} {token.max_uses === 1 ? "enrolment" : "enrolments"}
          </dd>
        </div>
        {/*
          The token itself, beside the command. Whether the command embeds the
          value or reads it from a file is the control plane's decision, and a
          page that showed only the command would, for the second shape, never
          show the credential at all.
        */}
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-slate-600 dark:text-slate-400">Enrolment token</dt>
          <dd id="enrolment-token-value" className="break-all font-mono text-xs">
            {token.enrolment_token}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-slate-600 dark:text-slate-400">Enrolment endpoint</dt>
          <dd className="break-all font-mono text-xs">{token.enrolment_endpoint}</dd>
        </div>
      </dl>
    </div>
  );
}

function EnrolConnector(): ReactElement {
  const { projectId } = projectRoute.useParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
  });

  const [expiry, setExpiry] = useState(3600);
  const [maxUses, setMaxUses] = useState("1");
  const [labels, setLabels] = useState("");
  const [issued, setIssued] = useState<EnrolmentToken | null>(null);

  const issue = useMutation({
    mutationFn: async () => {
      const declared = labels
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label !== "");
      const uses = Number.parseInt(maxUses, 10);
      return api.createEnrolmentToken({
        project_id: projectId,
        expires_in_seconds: expiry,
        max_uses: Number.isFinite(uses) && uses > 0 ? uses : 1,
        ...(declared.length === 0 ? {} : { environment_labels: declared }),
      });
    },
    onSuccess: (token) => {
      setIssued(token);
    },
  });

  // The enrolment happens on another machine, so the completion of this flow
  // arrives as a change in a list rather than as an answer to a request.
  const connectors = useQuery({
    queryKey: ["connectors"],
    queryFn: () => api.connectors(),
    refetchInterval: 5000,
  });

  const baseline = useRef<Set<string> | null>(null);
  const [arrivedId, setArrivedId] = useState<string | null>(null);

  useEffect(() => {
    const list = connectors.data;
    if (list === undefined) return;
    if (baseline.current === null) {
      // Connectors that were already active when this page opened did not just
      // enrol, and announcing them would be a false completion.
      baseline.current = new Set(
        list.filter((candidate) => candidate.status === "ACTIVE").map((candidate) => candidate.id),
      );
    }
    const known = baseline.current;
    const fresh = list.find(
      (candidate) => candidate.status === "ACTIVE" && !known.has(candidate.id),
    );
    if (fresh !== undefined) setArrivedId(fresh.id);
  }, [connectors.data]);

  const arrived = (connectors.data ?? []).find((candidate) => candidate.id === arrivedId) ?? null;
  const environmentId = arrived?.environment_id ?? null;
  const environment = useQuery({
    queryKey: ["environment", environmentId ?? ""],
    queryFn: async () => api.environment(environmentId ?? ""),
    enabled: environmentId !== null,
    refetchInterval: 5000,
  });

  const detected = environment.data;
  const workspace = detected?.workspaces[0];
  const completion =
    arrived === null || detected === undefined
      ? null
      : {
          environment: detected.name,
          version: arrived.version,
          platform: `${detected.platform}/${detected.architecture}`,
          health: CONNECTOR_HEALTH[arrived.status] ?? "status unknown",
          workspace: describeWorkspace(workspace),
        };

  // The five things `docs/UX_FLOWS.md` section 5 requires on completion, in one
  // sentence, because a live region is read aloud rather than scanned.
  const announcement =
    completion === null
      ? "Waiting for a connector to enrol. This page updates on its own; nothing needs refreshing."
      : `${completion.environment} is enrolled. Connector ${completion.version} on ${completion.platform}. Connection health: ${completion.health}. Authorised workspace: ${completion.workspace}.`;

  const scopeLabel =
    issued === null || (issued.project_id ?? null) === null
      ? "every project in this organisation"
      : (project.data?.name ?? issued.project_id ?? "");

  return (
    <section aria-labelledby="enrol-heading" className="max-w-3xl">
      <p className="text-sm">
        <Link
          to="/projects/$projectId/environments"
          params={{ projectId }}
          className="underline underline-offset-4"
        >
          Environments
        </Link>
      </p>
      <h2 id="enrol-heading" className="mt-2 text-xl font-semibold">
        Enrol a connector
      </h2>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        The connector runs on the machine your application runs on and dials out to this control
        plane. It opens no port there, and it uploads no repository contents. Enrolling gives it a
        certificate of its own; the private key is generated on that machine and never leaves it.
      </p>

      {issued === null ? (
        <form
          className="mt-6 flex flex-col gap-5"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            issue.mutate();
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="enrolment-expires" className="text-sm font-medium">
              Token lifetime
            </label>
            <select
              id="enrolment-expires"
              name="enrolment-expires"
              value={String(expiry)}
              onChange={(event) => {
                setExpiry(Number.parseInt(event.target.value, 10));
              }}
              className={FIELD}
              aria-describedby="enrolment-expires-hint"
            >
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.seconds} value={String(choice.seconds)}>
                  {choice.label}
                </option>
              ))}
            </select>
            <p id="enrolment-expires-hint" className={HINT}>
              The token is a credential until it is redeemed or expires. Choose the shortest
              lifetime that gets you to the machine.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="enrolment-max-uses" className="text-sm font-medium">
              Maximum uses
            </label>
            <input
              id="enrolment-max-uses"
              name="enrolment-max-uses"
              type="number"
              min={1}
              max={20}
              value={maxUses}
              onChange={(event) => {
                setMaxUses(event.target.value);
              }}
              className={`${FIELD} font-mono`}
              aria-describedby="enrolment-max-uses-hint"
            />
            <p id="enrolment-max-uses-hint" className={HINT}>
              One machine per token unless you are enrolling a fleet. Each use creates a separate
              connector identity.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="enrolment-labels" className="text-sm font-medium">
              Expected environment labels
            </label>
            <input
              id="enrolment-labels"
              name="enrolment-labels"
              type="text"
              value={labels}
              onChange={(event) => {
                setLabels(event.target.value);
              }}
              className={`${FIELD} font-mono`}
              placeholder="proxmox, development"
              aria-describedby="enrolment-labels-hint"
            />
            <p id="enrolment-labels-hint" className={HINT}>
              Comma separated, and optional. An environment that does not declare all of them is
              refused, so this is a check on which machine redeems the token.
            </p>
          </div>

          <button
            type="submit"
            className="self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
            disabled={issue.isPending}
          >
            {issue.isPending ? "Minting…" : "Mint enrolment token"}
          </button>

          {issue.error === null ? null : (
            <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
              {failureText(issue.error, "The enrolment token could not be minted.")}
            </p>
          )}
        </form>
      ) : (
        <IssuedToken token={issued} scopeLabel={scopeLabel} />
      )}

      <h3 className="mt-10 text-base font-semibold">Completion</h3>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        This page watches for the connector. When it arrives, what it reported appears here.
      </p>
      <p
        id="enrolment-progress"
        role="status"
        aria-live="polite"
        className="mt-3 text-sm text-slate-700 dark:text-slate-300"
      >
        {announcement}
      </p>

      {completion === null ? null : (
        <div className={`mt-4 ${CARD}`} data-enrolment-complete={arrived?.id ?? ""}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-slate-600 dark:text-slate-400">Environment</dt>
              <dd className="break-words">{completion.environment}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-600 dark:text-slate-400">Version</dt>
              <dd className="font-mono">{completion.version}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-600 dark:text-slate-400">Platform</dt>
              <dd className="font-mono">{completion.platform}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-600 dark:text-slate-400">Connection health</dt>
              <dd className="mt-1">
                <StatusBadge
                  tone={arrived === null ? "neutral" : (TONE_FOR_CONNECTOR[arrived.status] ?? "neutral")}
                  label={arrived?.status ?? ""}
                  detail={completion.health}
                />
              </dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-slate-600 dark:text-slate-400">Detected authorised workspace</dt>
              <dd className="break-words">{completion.workspace}</dd>
            </div>
          </dl>
          {workspace === undefined ? null : (
            <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <WorkspaceFacts workspace={workspace} />
            </div>
          )}
          <p className="mt-4 text-sm">
            <Link
              to="/projects/$projectId/environments"
              params={{ projectId }}
              className="underline underline-offset-4"
            >
              Back to environments
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

function ConnectorView(): ReactElement {
  const { projectId, connectorId } = projectConnectorRoute.useParams();
  const [activity, setActivity] = useState("");
  const connector = useQuery({
    queryKey: ["connector", connectorId],
    queryFn: () => api.connector(connectorId),
    refetchInterval: 5000,
    retry: false,
  });

  return (
    <section aria-labelledby="connector-heading" className="max-w-3xl">
      <p className="text-sm">
        <Link
          to="/projects/$projectId/environments"
          params={{ projectId }}
          className="underline underline-offset-4"
        >
          Environments
        </Link>
      </p>
      <h2 id="connector-heading" className="mt-2 min-w-0 break-all font-mono text-lg font-semibold">
        {connectorId}
      </h2>

      <p
        id="connector-activity"
        role="status"
        aria-live="polite"
        className="mt-3 text-sm text-slate-700 dark:text-slate-300"
      >
        {activity}
      </p>

      {connector.isPending ? <p role="status">Loading the connector.</p> : null}

      {connector.isError ? (
        <div className="mt-4">
          <h3 className="text-base font-semibold">No such connector</h3>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            {failureText(connector.error, "The connector could not be read.")}
          </p>
        </div>
      ) : null}

      {connector.data === undefined ? null : (
        <div className="mt-4 flex flex-col gap-4">
          <ConnectorPanel
            connector={connector.data}
            projectId={projectId}
            onOutcome={(outcome) => {
              setActivity(revocationSentence(outcome));
            }}
          />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-slate-600 dark:text-slate-400">Certificate expires</dt>
              <dd>{instant(connector.data.certificate_not_after)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-600 dark:text-slate-400">Environment</dt>
              <dd className="break-words">
                {known(connector.data.environment)
                  ? `${connector.data.environment.name} (${connector.data.environment.platform}/${connector.data.environment.architecture})`
                  : "not reported"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

export const projectEnvironmentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "environments",
  component: ProjectEnvironments,
});

export const projectEnrolConnectorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "environments/enrol",
  component: EnrolConnector,
});

export const projectConnectorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "environments/connectors/$connectorId",
  component: ConnectorView,
});
