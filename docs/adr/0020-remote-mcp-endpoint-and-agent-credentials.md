# ADR-0020: Serve the agent interface as a remote authenticated MCP endpoint with scoped agent credentials

- Status: Accepted
- Date: 2026-07-30

## Context

ADR-0003 chose MCP as the agent-facing interface and named two connection
forms: a local stdio bridge installed with the connector, and a remote
authenticated HTTP endpoint. It settled neither the credential an agent
presents, nor how a session decides which project it is working in, nor how the
authority rule of `docs/DOMAIN_MODEL.md` §15 — that a human-authored finding
cannot be finally accepted by an agent — survives contact with a protocol whose
tool arguments are chosen by the caller.

Stage 0 has no connector, so the stdio bridge has nothing to obtain credentials
from. The remote endpoint is the only form that can exist yet, and the Stage 0
exit criteria depend on it: "Claude Code or another MCP client can retrieve
`bugs-on-homepage`" and "Agent submits an after screenshot associated with a
finding".

Three further things were unsettled and had to be decided together.

`docs/SECURITY.md` §6.3 requires agent credentials to be short-lived, bound to
organisation and project, capability scoped and distinct from human sessions,
and requires that an agent token must not reach administrative APIs. Nothing
implemented that.

`docs/MCP_SPEC.md` §4 requires ambiguous project association to "fail with a
resolvable error rather than guessing", but MCP's own initialisation handshake
carries a client name, a client version and the MCP capability set, and has
nowhere to put a project hint.

`docs/MCP_SPEC.md` §7.7 lists the transitions an agent may perform and says
"human-only transitions remain unavailable". A runtime check that compares a
requested status against a list is a check somebody can forget, get wrong, or
route around.

## Decision

### The endpoint

The agent interface is a **remote authenticated HTTP endpoint** at `/mcp/v1`,
served by `apps/mcp-server`: a separate process with a separate gateway route,
sharing the domain layer of `apps/server` through the `@reviewplane/server/domain`
entry point rather than reimplementing it. The stdio bridge of
`docs/MCP_SPEC.md` §3.1 remains Stage 1 and will authenticate to this same
endpoint.

Session-scoped inputs MCP has nowhere for — `project_hint`, `workspace_hint`
and the client's own capability declaration — are **query parameters on the
endpoint URL**. A URL is the one thing every MCP client can be configured with.

### The credential

An agent credential is a bearer token with the prefix `rpa_`, stored only as a
SHA-256 digest, carrying:

- one organisation and a **non-empty set of projects**;
- a non-empty set of capabilities from a fixed vocabulary;
- an expiry, constrained by the database to at most 24 hours after issue.

It is issued by an administrator through
`POST /api/v1/organisations/:organisationId/agent-credentials` and returned
exactly once. No route re-shows it.

`requireAdministrator` refuses any token with the `rpa_` prefix with
`AUTHORISATION_DENIED`, **by shape rather than by lookup**. A refusal that
depended on resolving the credential would fail open exactly when the database
is unavailable, and §6.3 is not a rule that may hold only while PostgreSQL is
up. The prefix can cause a refusal and never an admission, so being wrong about
it is safe in the only direction that matters.

The endpoint reads an `Authorization: Bearer` header and nothing else. A viewer
session cookie is not consulted and is not resolvable by the agent credential
store, so a human session cannot stand in for an agent one — and the credential
is re-resolved on **every** HTTP request, so expiry or revocation stops the next
call rather than letting an open session run on.

### Project resolution

The credential's project set is the outer bound; a hint may only narrow it.
Where exactly one project survives, the session is bound to it. Where more than
one does, initialisation fails with `PROJECT_CONTEXT_AMBIGUOUS` **and the
candidates**, and no agent session row is created. `agent_sessions.project_id`
is `NOT NULL`, so a half-resolved session is not representable.

### Structural denial of the acceptance authority

The agent-facing status enumerations in
`packages/protocol/schemas/mcp/v1.schema.json` **do not contain**
`RESOLVED`, `WONT_FIX`, `DUPLICATE` or `ACCEPTED`. An agent cannot name a final
disposition, so it cannot request one; the tool schema a client is advertised
and the validator the server enforces are generated from that one file.

The domain rule in `apps/server/src/modules/reviews/domain.ts` is unchanged and
still refuses the same transitions for an `agent_session` actor. Both layers
hold, and they are not two implementations of one rule: the schema removes the
vocabulary, and the domain refuses the act.

### The response envelope

Every tool answers in the `docs/MCP_SPEC.md` §5 envelope, encoded through
`encodeMcpToolResponse`, which enforces two things the handler cannot opt out
of: the per-tool byte bound of §13, and the trust rule of §6 — a response
carrying page-derived or uploaded content cannot be encoded under a trusted
label.

A domain refusal is a **completed tool call reporting `ok: false`** with a
stable §12 code, not a JSON-RPC error. Only authentication, project resolution
and transport failures are HTTP errors, because at that point there is no
session to answer in.

### Idempotency

Keys are stored under the composite primary key
`(project_id, actor_type, actor_id, tool, key)` — the actor, tool and project
scoping §10 states — with a digest of the arguments. The key is claimed **before**
the work runs, so a duplicate submission produces one record; a key reused with
different arguments returns `IDEMPOTENCY_CONFLICT`; a key whose call refused is
released, because a refusal is not a result to replay for ever.

## Consequences

### Positive

- The Stage 0 exit criteria are reachable without a connector.
- One place decides what an agent may do: the credential's capability set, read
  from the session row it was copied onto when the session opened.
- The acceptance authority rule cannot be weakened by a code change in the MCP
  layer alone, because the layer has no way to express the request.
- Every response is bounded and labelled by construction rather than by
  convention, and the corpus in `packages/protocol/fixtures/mcp/v1/` holds both
  rules to committed bytes.
- Evidence reaches the agent through the ADR-0019 grant mechanism, so every read
  is audited and attributable to an agent session.

### Negative

- The MCP server holds a database connection and the worker command credential,
  so it is in the same trust zone as the control-plane server. It is a separate
  process and route, not a separate trust boundary. Splitting it further would
  need an internal API between two control-plane processes, which Stage 0 does
  not justify.
- Session state lives in the process that opened it. A restart ends every agent
  session; `session_resume` is advertised as `false`. A shared session store is
  the fix when a second replica arrives.
- Client capabilities on the URL are a ReviewPlane convention, not MCP. A client
  that ignores them gets the generous defaults, which is the right failure.
- The `rpa_` prefix is a small piece of credential structure that a token format
  change has to preserve.

## Alternatives considered

- **Reuse viewer sessions for agents.** Directly forbidden by
  `docs/SECURITY.md` §6.3, and it would make every agent write indistinguishable
  from a human's in the audit trail — which is the distinction the acceptance
  authority rule is decided on.
- **Run MCP inside `apps/server` on a sub-route.** Simpler to deploy and
  contrary to `docs/ARCHITECTURE.md` §4.4. It would also put the agent surface
  behind gateway rules written for the human API.
- **Enforce the agent transition list only in the domain layer.** Correct, and
  one layer. The tool schema would then advertise every status as requestable,
  and an agent would discover the boundary as a refusal rather than as a
  contract.
- **Zod schemas for tool arguments, as the MCP SDK's convenience wrapper
  expects.** Rejected under ADR-0013: it would be a second declaration of every
  tool's arguments, free to drift from the schema source. The low-level SDK
  server is used instead, advertising the JSON Schema extracted from the source
  and enforcing the validator generated from it.
- **Fail an ambiguous binding at the first tool call rather than at
  initialisation.** It would let an agent connect and then find nothing works.
  Refusing to create the session is the earlier, clearer failure.

## Follow-up

- The stdio bridge of `docs/MCP_SPEC.md` §3.1, obtaining these credentials from
  the connector (Stage 1).
- Inbox tools and the §9 workflow (Stage 1), at which point
  `review_inbox` becomes `true`.
- A shared agent-session store when a second MCP replica is deployed.
- An expiry sweep for `agent_credentials` and `idempotency_keys`, with the
  retention work of Stage 2.
