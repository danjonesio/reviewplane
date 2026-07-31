/**
 * What one MCP connection is, and what it may do.
 *
 * A connection is an agent session (`docs/DOMAIN_MODEL.md` section 11) plus the
 * capability negotiation of `docs/MCP_SPEC.md` section 4. Both are decided once,
 * when the connection opens, and read from the row afterwards — so a credential
 * revoked mid-session stops the *next* request at the HTTP layer rather than
 * silently changing what the current one is allowed to do.
 *
 * The client capabilities arrive as query parameters on the endpoint URL rather
 * than through MCP's own handshake, which carries `clientInfo` and the MCP
 * capability set and has nowhere to put `project_hint` or `image_content`. A
 * URL is the one thing every MCP client can be configured with, so the hints
 * ride on it (`docs/MCP_SPEC.md` section 3.2).
 */

import type { Pool } from "pg";

import type { ServerCapabilities as ProtocolServerCapabilities } from "@reviewplane/protocol/mcp";
import type {
  AgentCredential,
  AgentCredentialStore,
  AgentSessionRecord,
  AgentSessionStore,
  ArtefactService,
  BrowserSessionService,
  IdempotencyStore,
  ProjectReference,
  ReviewService,
  Scope,
  WorkspaceRecord,
  WorkspaceStore,
} from "@reviewplane/server/domain";

import type { McpServerConfig } from "./config.ts";
import type { DevelopmentServiceCommands } from "./development-services.ts";

/** Everything a tool needs that is not part of one request. */
export interface McpServices {
  readonly pool: Pool;
  readonly config: McpServerConfig;
  readonly reviews: ReviewService;
  readonly artefacts: ArtefactService;
  readonly browserSessions: BrowserSessionService;
  readonly agentCredentials: AgentCredentialStore;
  readonly agentSessions: AgentSessionStore;
  readonly workspaces: WorkspaceStore;
  readonly idempotency: IdempotencyStore;
  /** Published development services (`docs/MCP_SPEC.md` section 7.2). */
  readonly developmentServices: DevelopmentServiceCommands;
}

/** What the client said it can consume (`docs/MCP_SPEC.md` section 4). */
export interface ClientCapabilities {
  readonly resources: boolean;
  readonly image_content: boolean;
  readonly managed_messages: boolean;
  readonly session_resume: boolean;
}

export interface McpConnection {
  readonly session: AgentSessionRecord;
  readonly credential: AgentCredential;
  readonly project: ProjectReference;
  readonly workspace: WorkspaceRecord | null;
  readonly client: { readonly name: string; readonly version: string };
  readonly clientCapabilities: ClientCapabilities;
  readonly serverCapabilities: ProtocolServerCapabilities;
  readonly scope: Scope;
}

/**
 * Reads the client capability declaration from the endpoint URL.
 *
 * Defaults are generous where a false value would degrade the experience and
 * conservative where a true value would assume something the client never
 * claimed: `resources` and `image_content` default to true because the great
 * majority of MCP clients support both and a client that does not says so;
 * `managed_messages` defaults to false because Stage 0 pushes nothing anyway
 * (`docs/ARCHITECTURE.md` section 8.3).
 */
export function readClientCapabilities(query: URLSearchParams): ClientCapabilities {
  const flag = (name: string, fallback: boolean): boolean => {
    const value = query.get(name);
    if (value === null || value === "") return fallback;
    return value !== "false" && value !== "0";
  };
  return {
    resources: flag("resources", true),
    image_content: flag("image_content", true),
    managed_messages: false,
    session_resume: flag("session_resume", false),
  };
}

/**
 * What the server will do for this session.
 *
 * `image_resources` is the negotiated result and not a property of the server:
 * a client that declared no image capability is told so here, and every later
 * degradation is a consequence a client can plan for rather than a surprise.
 * `review_inbox` is false because Stage 0 exposes no inbox tools at all, which
 * is more honest than advertising an empty one.
 */
export function negotiateCapabilities(
  client: ClientCapabilities,
): ProtocolServerCapabilities {
  return {
    browser_live: true,
    image_resources: client.resources && client.image_content,
    human_takeover: true,
    review_inbox: false,
    managed_messages: false,
    session_resume: false,
  };
}

/** The policy summary every session is told about itself. */
export const STAGE_0_POLICY = {
  // AGENTS.md: a human-authored finding cannot be finally accepted by an agent.
  agent_may_accept_findings: false,
  // AGENTS.md: do not claim an issue is fixed without verification evidence.
  verification_required: true,
  // docs/SECURITY.md section 12.1, in its strongest form: there is no tool.
  secret_tools_available: false,
  // AGENTS.md "Browser-facing work".
  required_viewports: ["390x844", "1440x900"],
} as const;
