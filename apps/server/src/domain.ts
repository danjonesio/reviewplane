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
  InboxStore,
  LIVE_INBOX_STATUSES,
  type InboxItemRecord,
  type InboxItemStatus,
  type InboxItemType,
  type InboxPage,
  type InboxRecipientType,
  type InboxScope,
} from "./modules/agents/inbox.ts";
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
  UNRESTRICTED_SCOPE,
  artefactIsActiveContent,
  dispositionOf,
  type ArtefactGrant,
  type ArtefactRecord,
  type ArtefactScope,
  type ArtefactStoreStatus,
  type ThumbnailState,
} from "./modules/artefacts/service.ts";
export {
  loadArtefactStoreConfig,
  loadRetentionWindows,
  DEFAULT_ARTEFACT_MAX_BYTES,
  DEFAULT_ARTEFACT_PATH,
  DEFAULT_RETENTION_DAYS,
  type ArtefactStoreConfig,
  type RetentionWindows,
} from "./modules/artefacts/config.ts";
export { artefactJobHandlers } from "./modules/artefacts/jobs.ts";
export {
  acceptedContentTypes,
  contentTypesForKind,
  dispositionFor,
  isActiveContentType,
  STAGE_1_ARTEFACT_KINDS,
  type ArtefactDisposition,
} from "./modules/artefacts/kinds.ts";
export {
  ArtefactStoreError,
  FilesystemArtefactStore,
  S3ArtefactStore,
  createArtefactStore,
  keyForDigest,
  temporaryArtefactStore,
  type ArtefactStorageDriver,
  type ArtefactStore,
  type ArtefactStoreUsage,
  type S3ArtefactStoreOptions,
  type StoredObject,
} from "./modules/artefacts/store/index.ts";

export {
  ALLOCATION_DEADLINE_MS,
  ALLOCATION_GRACE_MS,
  BrowserSessionService,
  DEFAULT_SESSION_LIMITS,
  allocationFailureClassOf,
  type AllocationAuthoriser,
  type AllocationFailureClass,
  type BrowserSessionRecord,
  type SessionCapabilityRevoker,
  type SessionScope,
} from "./modules/browser-sessions/service.ts";
export { PublishedServiceBinder } from "./modules/published-services/session-binder.ts";
export { BrowserWorkerClient } from "./modules/browser-sessions/worker-client.ts";
export { WorkerRegistry } from "./modules/browser-sessions/workers.ts";

export {
  ACTIVE_REVIEW_STATUSES,
  AGENT_REVIEW_STATUSES,
  AGENT_TRANSITION_LABELS,
  CLOSING_REVIEW_STATUSES,
  isHumanReservedStatus,
  agentTransitionsFrom,
  assertActorMayMoveFinding,
  assertActorMayMoveReview,
  assertCompletionEvidence,
  assertDecisionReason,
  assertExpectedVersion,
  assertFindingTakesVerification,
  assertFindingTransition,
  assertVerificationUnderReview,
  assertReviewAcceptable,
  assertReviewMutable,
  assertReviewTransition,
  assertVerificationCommitContext,
  isHumanActor,
} from "./modules/reviews/domain.ts";
export {
  HUMAN_REVIEW_NOT_REQUESTED,
  aggregateCompletionResult,
  aggregateMissing,
  assuranceFor,
  completionRequirementsFor,
  evidenceWarnings,
  findingCompletionState,
  missingEvidence,
  nextActions,
  viewportRequirementLabel,
  viewportSatisfies,
  type CompletionRequirements,
  type EvidenceAssurance,
  type EvidenceUnderReview,
  type FindingCompletionState,
} from "./modules/reviews/completion.ts";
export { REVIEW_EXPORT_CONTENT_TYPE, reviewExportHandler } from "./modules/reviews/export-job.ts";
export {
  ReviewService,
  sourceForActor,
  type AssignReviewInput,
  type DisposeFindingInput,
  type ReviewExport,
  type ReviewListFilter,
  type ReviewSearchField,
  type ReviewTransitionInput,
  type Scope,
  type SubmitVerificationInput,
  type Verification,
} from "./modules/reviews/service.ts";

export {
  STAGE_0_DESTINATION_POLICY,
  type DestinationPolicy,
} from "./modules/published-services/destination-policy.ts";
export { HttpTunnelGateway, type TunnelGateway } from "./modules/published-services/gateway-client.ts";
export {
  PublishedServiceService,
  type CreatePublishedServiceInput,
  type PublishedServiceConfig,
  type PublishedServiceView,
  type RoutePublisher,
} from "./modules/published-services/service.ts";
export type { CallerScope, PublishedServiceStatus } from "./modules/published-services/repository.ts";
