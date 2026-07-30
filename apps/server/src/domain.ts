/**
 * `@reviewplane/server/domain` — the domain the MCP server translates agent
 * tools into.
 *
 * `docs/ARCHITECTURE.md` section 4.4 says the MCP server "may share packages
 * and deployment image with the server but should be a separate process and
 * route", and that its job is to "translate MCP operations into domain
 * commands". This module is what makes that literal: `apps/mcp-server` imports
 * the same `ReviewService`, the same authority rules and the same event writer
 * that `apps/server`'s HTTP handlers use, rather than a second implementation
 * of them.
 *
 * That matters most for the rules nobody wants two copies of. The refusal that
 * stops an agent finally accepting a human's finding lives in
 * `modules/reviews/domain.ts`. The MCP layer additionally cannot *express* such
 * a request, but if the two ever disagreed the domain rule would still hold —
 * which is only true because both processes run the same function.
 *
 * The export surface is deliberately narrow. It carries domain services, the
 * agent-integration stores and the error type, and it does **not** carry the
 * HTTP routes: a second process reaching into another's route registration
 * would make "separate process and route" a formality.
 */

export { API_ERROR_CODES, ApiError, apiData, apiError, notFound, type ErrorCode } from "./errors.ts";
export {
  appendEvent,
  assertPayloadCarriesNoSecret,
  recordStateChange,
  EventPayloadError,
  type ActorType,
  type AppendedEvent,
  type EventActor,
  type EventCorrelation,
  type EventPublisher,
} from "./events/append.ts";
export { EventBus, EventStreamReader, type StoredEvent } from "./events/stream.ts";
export { OutboxDispatcher } from "./events/outbox.ts";
export {
  PROCESS_ROLES,
  readBuildInfo,
  registerHealthRoutes,
  type BuildInfo,
  type ProcessRole,
} from "./health.ts";
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  buildPage,
  pageMeta,
  readPageRequest,
  type Page,
  type PageRequest,
} from "./http/pagination.ts";
export { JobRunner, enqueueJob, type JobHandler, type JobKind, type JobRecord } from "./jobs/runner.ts";
export { newEntityId, newId } from "./ids.ts";
export { inTransaction } from "./db/pool.ts";
export { migrate, migrationState, type MigrationState } from "./db/migrate.ts";

export {
  AGENT_CAPABILITIES,
  AGENT_CREDENTIAL_TTL_SECONDS,
  AGENT_TOKEN_PREFIX,
  AgentCredentialStore,
  looksLikeAgentToken,
  type AgentCredential,
  type IssuedAgentCredential,
} from "./modules/agents/credentials.ts";
export {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyStore,
  requestDigest,
  type IdempotencyOutcome,
  type IdempotencyScope,
} from "./modules/agents/idempotency.ts";
export {
  AgentSessionStore,
  agentActor,
  type AgentSessionRecord,
  type AgentSessionStatus,
  type ProjectReference,
} from "./modules/agents/sessions.ts";
export { WorkspaceStore, type WorkspaceRecord } from "./modules/agents/workspaces.ts";

export {
  ARTEFACT_GRANT_TTL_SECONDS,
  ArtefactService,
  type ArtefactGrant,
  type ArtefactRecord,
} from "./modules/artefacts/service.ts";
export {
  FilesystemArtefactStore,
  keyForDigest,
  type ArtefactStore,
} from "./modules/artefacts/store.ts";

export {
  BrowserSessionService,
  DEFAULT_SESSION_LIMITS,
  type BrowserSessionRecord,
} from "./modules/browser-sessions/service.ts";
export { BrowserWorkerClient } from "./modules/browser-sessions/worker-client.ts";
export { WorkerRegistry } from "./modules/browser-sessions/workers.ts";

export {
  AGENT_TRANSITION_LABELS,
  agentTransitionsFrom,
  assertActorMayMoveFinding,
  assertCompletionEvidence,
  assertExpectedVersion,
  assertFindingTransition,
  assertReviewTransition,
  assertVerificationCommitContext,
} from "./modules/reviews/domain.ts";
export {
  ReviewService,
  type Scope,
  type SubmitVerificationInput,
  type Verification,
} from "./modules/reviews/service.ts";
