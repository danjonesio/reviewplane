/**
 * The remote authenticated MCP endpoint (`docs/MCP_SPEC.md` section 3.2,
 * `docs/API.md` section 3).
 *
 * Composition only, with three decisions that are security properties rather
 * than plumbing.
 *
 * **Every request is authenticated, not just the first.** The credential is
 * resolved on each HTTP request, so a credential that expires or is revoked
 * mid-session stops the next call with `AUTHENTICATION_REQUIRED` rather than
 * letting an already-open session run on. `docs/TESTING.md` section 11 asks for
 * exactly that, and "rather than partial execution" is why the check is before
 * the transport rather than inside a tool.
 *
 * **A human cookie is not agent authentication.** The endpoint reads a bearer
 * credential and nothing else. A viewer session cookie is not consulted, is not
 * resolvable by the agent credential store, and produces the same refusal as no
 * credential at all (`docs/MCP_SPEC.md` section 3.2, `docs/SECURITY.md`
 * section 6.3).
 *
 * **The session belongs to the credential that opened it.** The transport
 * session identifier is not a credential: a request presenting somebody else's
 * identifier with a valid credential of its own is refused, because the stored
 * connection records which credential opened it.
 */

import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  AgentCredentialStore,
  AgentSessionStore,
  ApiError,
  ArtefactService,
  BrowserSessionService,
  BrowserWorkerClient,
  IdempotencyStore,
  HttpTunnelGateway,
  InboxStore,
  PublishedServiceService,
  ReviewService,
  STAGE_0_DESTINATION_POLICY,
  WorkerRegistry,
  WorkspaceStore,
  createArtefactStore,
  loadArtefactStoreConfig,
  loadRetentionWindows,
  registerHealthRoutes,
  type ArtefactStore,
  type RoutePublisher,
} from "@reviewplane/server/domain";

import type { McpServerConfig } from "./config.ts";
import {
  negotiateCapabilities,
  readClientCapabilities,
  type McpConnection,
  type McpServices,
} from "./context.ts";
import { DevelopmentServiceCommands } from "./development-services.ts";
import { buildMcpServer } from "./server.ts";
import { assertToolSetMatchesSchema } from "./tools.ts";

export interface BuildMcpAppOptions {
  readonly config: McpServerConfig;
  readonly pool: Pool;
  readonly artefactStore?: ArtefactStore;
  readonly workerFetch?: typeof fetch;
  readonly logger?: boolean;
  /**
   * Substituted by the integration harness, which runs the `api` role and this
   * one in a single process and so does hold the connector's control channel.
   * Production leaves it unset and gets {@link UnreachableRoutePublisher}.
   */
  readonly routePublisher?: RoutePublisher;
}

/**
 * The publisher this process cannot have.
 *
 * `PublishedServiceService.complete` is never called here — the MCP tools call
 * `request` and wait for `api` to finish the route — and this refuses loudly if
 * that ever stops being true, rather than silently marking a perfectly good
 * route `failed`.
 */
class UnreachableRoutePublisher implements RoutePublisher {
  publish(): Promise<{ readonly observedDestination: string }> {
    return Promise.reject(
      new ApiError(
        "CONTROL_PLANE_UNAVAILABLE",
        "The MCP endpoint holds no connector control channel; a requested route is completed by the control-plane API (ADR-0021).",
      ),
    );
  }
}

export interface BuiltMcpApp {
  readonly app: FastifyInstance;
  readonly services: McpServices;
  /** Live connections, for shutdown and for the tests to inspect. */
  readonly connections: ReadonlyMap<string, McpConnection>;
  close(): Promise<void>;
}

interface LiveConnection {
  readonly connection: McpConnection;
  readonly transport: StreamableHTTPServerTransport;
  readonly credentialId: string;
}

/** MCP bodies are JSON-RPC messages; a megabyte is generous for one. */
const BODY_LIMIT = 1048576;

export async function buildMcpApp(options: BuildMcpAppOptions): Promise<BuiltMcpApp> {
  assertToolSetMatchesSchema();

  const { config, pool } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: BODY_LIMIT });

  // ADR-0012: the MCP endpoint reads evidence through the same driver the API
  // wrote it with, chosen from the same configuration. A deployment running the
  // `s3` driver would otherwise have an agent reading an empty local directory.
  const store =
    options.artefactStore ??
    createArtefactStore(
      loadArtefactStoreConfig(process.env, {
        path: config.artefactPath,
        maxBytes: config.artefactMaxBytes,
      }),
    );
  const artefacts = new ArtefactService(pool, store, config.artefactMaxBytes, {
    retention: loadRetentionWindows(process.env),
  });
  const reviews = new ReviewService(pool, artefacts, app.log);
  const workers = new WorkerRegistry(pool, "");
  const workerClient = new BrowserWorkerClient({
    endpoint: config.workerEndpoint,
    credential: config.workerCommandCredential,
    timeoutMs: config.workerRequestTimeoutMs,
    ...(options.workerFetch === undefined ? {} : { fetchImplementation: options.workerFetch }),
  });
  const browserSessions = new BrowserSessionService(pool, workers, workerClient);
  const agentCredentials = new AgentCredentialStore(pool);
  const workspaces = new WorkspaceStore(pool);
  const agentSessions = new AgentSessionStore(pool, workspaces);
  const idempotency = new IdempotencyStore(pool);
  const inbox = new InboxStore(pool);

  // Published development services (`docs/MCP_SPEC.md` section 7.2).
  //
  // The service is built here **without a capability signing key**. Minting is
  // what binds a route to one browser session, the control plane is the minting
  // authority (`docs/ARCHITECTURE.md` section 7.3), and this process drives no
  // browser session: a process that cannot mint cannot leak a minting key, and
  // `PublishedServiceService.mint` refuses rather than signing with a
  // placeholder.
  //
  // It is built without a working `RoutePublisher` for the same kind of reason.
  // A connector dials the control plane, so its control channel terminates in
  // the `api` process; this one writes a route as `requested` and `api` finishes
  // it (ADR-0021). A publisher that could reach the connector from here would be
  // a second network path into a development machine.
  const developmentServices = new DevelopmentServiceCommands(
    pool,
    new PublishedServiceService(
      pool,
      new HttpTunnelGateway({
        baseUrl: config.tunnelControlUrl,
        token: config.tunnelControlToken,
      }),
      options.routePublisher ?? new UnreachableRoutePublisher(),
      {
        destinationPolicy: STAGE_0_DESTINATION_POLICY,
        internalSuffix: config.internalSuffix,
        routeTtlMaxSeconds: config.routeTtlMaxSeconds,
        maxRoutesPerConnector: 10,
      },
    ),
    config.publishWaitMs,
  );

  const services: McpServices = {
    pool,
    config,
    reviews,
    artefacts,
    browserSessions,
    agentCredentials,
    agentSessions,
    workspaces,
    idempotency,
    developmentServices,
    inbox,
  };

  const live = new Map<string, LiveConnection>();
  const connections = new Map<string, McpConnection>();

  const refuse = (reply: FastifyReply, request: FastifyRequest, error: ApiError): FastifyReply =>
    reply.status(error.status).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined || Object.keys(error.details).length === 0
          ? {}
          : { details: error.details }),
      },
      meta: { request_id: request.id },
    });

  /**
   * The credential behind this request.
   *
   * Only an `Authorization: Bearer` header is consulted. There is no cookie
   * path and no query-parameter path: `docs/SECURITY.md` section 18 forbids a
   * credential in a URL, and section 6.3 forbids a human session standing in
   * for an agent one.
   */
  const requireCredential = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer +([!-~]+)$/u.exec(header) : null;
    const credential =
      match === null ? null : await agentCredentials.resolve(match[1] as string);
    if (credential === null) {
      throw new ApiError(
        "AUTHENTICATION_REQUIRED",
        "A scoped agent credential is required on this endpoint. A human session cookie is not agent authentication.",
      );
    }
    return credential;
  };

  // `docs/OPERATIONS.md` section 2 requires every service to expose the same
  // three endpoints, and names "MCP not ready when authorisation backend is
  // unavailable" as this role's readiness question. The authorisation backend
  // is the credential store in PostgreSQL, so the shared readiness check — a
  // reachable database whose migrations are all applied — is exactly it.
  registerHealthRoutes(app, { role: "mcp", pool });
  // Retained: the Stage 0 name the Compose health check already uses.
  app.get("/health", async () => ({ status: "ok" }));

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const credential = await requireCredential(request);
    const query = new URL(request.url, "http://mcp.invalid").searchParams;
    const presented = request.headers["mcp-session-id"];
    const sessionId = typeof presented === "string" ? presented : null;

    if (sessionId !== null) {
      const existing = live.get(sessionId);
      if (existing === undefined) {
        // Unknown to this process. The transport would answer 404 itself; doing
        // it here keeps the refusal in the product's error vocabulary.
        throw new ApiError("RESOURCE_NOT_FOUND", "This MCP session is not known to this server.");
      }
      if (existing.credentialId !== credential.id) {
        throw new ApiError(
          "AUTHORISATION_DENIED",
          "This MCP session was opened with a different credential.",
        );
      }
      reply.hijack();
      await existing.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    const body = request.body as
      | { method?: string; params?: { clientInfo?: { name?: string; version?: string } } }
      | undefined;
    if (request.method !== "POST" || body?.method !== "initialize") {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "An MCP session must be initialised before any other request.",
      );
    }

    // Project resolution happens before the session exists. An ambiguous
    // binding is refused here with the candidates, so the agent reconnects
    // naming one rather than working in a project nobody chose.
    const project = await agentSessions.resolveProject(credential, query.get("project_hint"));
    const clientCapabilities = readClientCapabilities(query);
    const transportSessionId = randomUUID();
    const started = await agentSessions.start({
      credential,
      project,
      workspaceHint: query.get("workspace_hint"),
      agentType: body.params?.clientInfo?.name ?? "unknown",
      agentVersion: body.params?.clientInfo?.version ?? "unknown",
      clientCapabilities: { ...clientCapabilities },
      transportSessionId,
    });

    const connection: McpConnection = {
      session: started.session,
      credential,
      project,
      workspace: started.workspace,
      client: {
        name: body.params?.clientInfo?.name ?? "unknown",
        version: body.params?.clientInfo?.version ?? "unknown",
      },
      clientCapabilities,
      serverCapabilities: negotiateCapabilities(clientCapabilities),
      scope: { organisationId: credential.organisationId, projectId: project.id },
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => transportSessionId,
      // Plain JSON responses rather than an event stream: Stage 0 pushes
      // nothing to an agent (`docs/ARCHITECTURE.md` section 8.3
      // `managed_messages: false`), so a stream would be an idle socket.
      enableJsonResponse: true,
      onsessionclosed: async (closed: string) => {
        live.delete(closed);
        connections.delete(closed);
        await agentSessions
          .end(started.session.id, "COMPLETED", "the client closed the MCP session")
          .catch(() => undefined);
      },
    });
    const server = buildMcpServer(connection, services);
    // The SDK's `Transport` declares `onclose?: () => void` while the transport
    // class exposes it as a getter that may return `undefined`. Under
    // `exactOptionalPropertyTypes` those are different types; the cast records
    // that mismatch rather than relaxing the compiler option for the repository.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

    live.set(transportSessionId, { connection, transport, credentialId: credential.id });
    connections.set(transportSessionId, connection);

    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  const route = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await handle(request, reply);
    } catch (error) {
      if (reply.raw.headersSent) throw error;
      if (error instanceof ApiError) {
        await refuse(reply, request, error);
        return;
      }
      request.log.error({ err: error }, "mcp request failed");
      await refuse(
        reply,
        request,
        new ApiError("INTERNAL_ERROR", "The request could not be completed."),
      );
    }
  };

  for (const method of ["POST", "GET", "DELETE"] as const) {
    app.route({ method, url: config.mcpPath, handler: route });
  }

  return {
    app,
    services,
    connections,
    async close() {
      // The control plane going away is, from the agent's side, the session
      // being disconnected — not completed. `docs/EVENTS.md` section 7 has both
      // names and they mean different things: a completed session finished its
      // work, and a disconnected one stopped mid-flight with whatever it was
      // doing unfinished. Recording the wrong one would tell a human reading the
      // timeline that an agent walked away satisfied.
      //
      // The write is best effort. If the database is what went away, the
      // session cannot be stamped and the loss is logged rather than allowed to
      // stop a shutdown.
      for (const [, entry] of live) {
        await agentSessions
          .end(entry.connection.session.id, "DISCONNECTED", "the control plane stopped serving")
          .catch((error: unknown) => {
            app.log.warn({ err: error }, "agent session could not be marked disconnected");
          });
        await entry.transport.close().catch(() => undefined);
      }
      live.clear();
      connections.clear();
      await app.close();
    },
  };
}
