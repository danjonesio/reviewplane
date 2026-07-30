--
-- PostgreSQL database dump
--

\restrict y8vTEmGG4lEkvwUBEe1c8a5l7GTjZT4V0YK34JdvXyqMZc7MnX2rWlGupaRg8zx

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: reviewplane_geometry_is_normalised(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reviewplane_geometry_is_normalised(geometry jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    SELECT jsonb_typeof(geometry) = 'object'
       AND (geometry ? 'x') AND (geometry ? 'y')
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each(geometry) AS member(name, value)
            WHERE member.name NOT IN ('x', 'y', 'width', 'height', 'x2', 'y2')
               OR jsonb_typeof(member.value) <> 'number'
               OR (member.value #>> '{}')::numeric < 0
               OR (member.value #>> '{}')::numeric > 1
       );
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_credentials (
    id text NOT NULL,
    token_sha256 text NOT NULL,
    organisation_id text NOT NULL,
    project_ids text[] NOT NULL,
    capabilities text[] NOT NULL,
    label text NOT NULL,
    issued_to_client text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT agent_credentials_capabilities_known CHECK ((capabilities <@ ARRAY['project:read'::text, 'review:read'::text, 'review:write'::text, 'finding:read'::text, 'finding:write'::text, 'verification:submit'::text, 'browser:capture'::text])),
    CONSTRAINT agent_credentials_capabilities_non_empty CHECK ((array_length(capabilities, 1) > 0)),
    CONSTRAINT agent_credentials_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT agent_credentials_scope_non_empty CHECK ((array_length(project_ids, 1) > 0)),
    CONSTRAINT agent_credentials_short_lived CHECK ((expires_at <= (created_at + '24:00:00'::interval)))
);


--
-- Name: agent_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_sessions (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    credential_id text NOT NULL,
    workspace_id text,
    agent_type text NOT NULL,
    agent_version text NOT NULL,
    capabilities text[] NOT NULL,
    client_capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    transport_session_id text,
    branch text,
    head_commit text,
    status text DEFAULT 'STARTING'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    ended_at timestamp with time zone,
    CONSTRAINT agent_sessions_capabilities_non_empty CHECK ((array_length(capabilities, 1) > 0)),
    CONSTRAINT agent_sessions_commit_shape CHECK (((head_commit IS NULL) OR (head_commit ~ '^[0-9a-f]{7,64}$'::text))),
    CONSTRAINT agent_sessions_status_known CHECK ((status = ANY (ARRAY['STARTING'::text, 'ACTIVE'::text, 'WAITING'::text, 'BLOCKED'::text, 'DISCONNECTED'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);


--
-- Name: annotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.annotations (
    id text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    finding_id text NOT NULL,
    artefact_id text NOT NULL,
    type text NOT NULL,
    geometry jsonb NOT NULL,
    label text NOT NULL,
    marker_number integer,
    style_hint text DEFAULT 'default'::text NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text,
    created_by_actor_display text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT annotations_actor_type_known CHECK ((created_by_actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT annotations_geometry_matches_type CHECK (
CASE type
    WHEN 'rectangle'::text THEN ((geometry ? 'width'::text) AND (geometry ? 'height'::text) AND (NOT (geometry ? 'x2'::text)) AND (NOT (geometry ? 'y2'::text)))
    WHEN 'ellipse'::text THEN ((geometry ? 'width'::text) AND (geometry ? 'height'::text) AND (NOT (geometry ? 'x2'::text)) AND (NOT (geometry ? 'y2'::text)))
    WHEN 'arrow'::text THEN ((geometry ? 'x2'::text) AND (geometry ? 'y2'::text) AND (NOT (geometry ? 'width'::text)) AND (NOT (geometry ? 'height'::text)))
    ELSE ((NOT (geometry ? 'width'::text)) AND (NOT (geometry ? 'height'::text)) AND (NOT (geometry ? 'x2'::text)) AND (NOT (geometry ? 'y2'::text)))
END),
    CONSTRAINT annotations_geometry_normalised CHECK (public.reviewplane_geometry_is_normalised(geometry)),
    CONSTRAINT annotations_marker_number_range CHECK (((marker_number IS NULL) OR ((marker_number >= 1) AND (marker_number <= 999)))),
    CONSTRAINT annotations_revision_positive CHECK ((revision >= 1)),
    CONSTRAINT annotations_style_hint_known CHECK ((style_hint = ANY (ARRAY['default'::text, 'critical'::text, 'informational'::text]))),
    CONSTRAINT annotations_type_known CHECK ((type = ANY (ARRAY['rectangle'::text, 'ellipse'::text, 'arrow'::text, 'point'::text, 'numbered_marker'::text])))
);


--
-- Name: annotations_current; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.annotations_current AS
 SELECT DISTINCT ON (id) id,
    revision,
    organisation_id,
    project_id,
    finding_id,
    artefact_id,
    type,
    geometry,
    label,
    marker_number,
    style_hint,
    created_by_actor_type,
    created_by_actor_id,
    created_by_actor_display,
    created_at,
    deleted_at
   FROM public.annotations
  ORDER BY id, revision DESC;


--
-- Name: artefact_access_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artefact_access_grants (
    id text NOT NULL,
    artefact_id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    use_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT artefact_grants_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT artefact_grants_subject_type_known CHECK ((subject_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'browser_worker'::text, 'system'::text]))),
    CONSTRAINT artefact_grants_use_count_non_negative CHECK ((use_count >= 0))
);


--
-- Name: artefacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artefacts (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    storage_key text,
    content_type text NOT NULL,
    declared_size_bytes bigint NOT NULL,
    declared_sha256 text NOT NULL,
    size_bytes bigint,
    sha256 text,
    redaction_state text DEFAULT 'not_applied'::text NOT NULL,
    retention_class text NOT NULL,
    browser_session_id text,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    available_at timestamp with time zone,
    expires_at timestamp with time zone,
    content_width_px integer,
    content_height_px integer,
    filename_label text,
    CONSTRAINT artefacts_available_image_is_measured CHECK (((state <> 'available'::text) OR (content_type <> ALL (ARRAY['image/png'::text, 'image/jpeg'::text])) OR ((content_width_px IS NOT NULL) AND (content_height_px IS NOT NULL)))),
    CONSTRAINT artefacts_available_is_verified CHECK (((state <> 'available'::text) OR ((storage_key IS NOT NULL) AND (sha256 IS NOT NULL) AND (size_bytes IS NOT NULL) AND (sha256 = declared_sha256) AND (size_bytes = declared_size_bytes) AND (available_at IS NOT NULL)))),
    CONSTRAINT artefacts_content_rectangle_positive CHECK ((((content_width_px IS NULL) AND (content_height_px IS NULL)) OR ((content_width_px > 0) AND (content_height_px > 0) AND (content_width_px <= 32767) AND (content_height_px <= 32767)))),
    CONSTRAINT artefacts_declared_digest_shape CHECK ((declared_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artefacts_filename_label_is_a_name CHECK (((filename_label IS NULL) OR ((filename_label ~ '^[A-Za-z0-9._-]{1,128}$'::text) AND (filename_label !~ '[.][.]'::text)))),
    CONSTRAINT artefacts_kind_known CHECK ((kind = ANY (ARRAY['screenshot'::text, 'thumbnail'::text, 'trace'::text, 'har'::text, 'video'::text, 'dom_snapshot'::text, 'accessibility_snapshot'::text, 'console_log'::text, 'network_log'::text, 'review_export'::text]))),
    CONSTRAINT artefacts_redaction_state_known CHECK ((redaction_state = ANY (ARRAY['not_applied'::text, 'pending'::text, 'applied'::text, 'failed'::text]))),
    CONSTRAINT artefacts_retention_class_known CHECK ((retention_class = ANY (ARRAY['action_screenshots'::text, 'browser_traces'::text, 'session_video'::text, 'console_and_network_logs'::text, 'verification_evidence'::text]))),
    CONSTRAINT artefacts_state_known CHECK ((state = ANY (ARRAY['pending'::text, 'uploaded'::text, 'available'::text, 'failed'::text]))),
    CONSTRAINT artefacts_verified_digest_shape CHECK (((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    worker_id text,
    agent_session_id text,
    published_service_id text,
    service_origin text,
    browser_type text DEFAULT 'chromium'::text NOT NULL,
    browser_version text,
    status text NOT NULL,
    current_controller_type text,
    current_controller_id text,
    control_epoch integer DEFAULT 0 NOT NULL,
    last_sequence bigint DEFAULT '-1'::integer NOT NULL,
    viewport jsonb NOT NULL,
    limits jsonb NOT NULL,
    retention_policy text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT browser_sessions_controller_known CHECK (((current_controller_type IS NULL) OR (current_controller_type = ANY (ARRAY['agent'::text, 'human'::text, 'system'::text])))),
    CONSTRAINT browser_sessions_epoch_non_negative CHECK ((control_epoch >= 0)),
    CONSTRAINT browser_sessions_status_known CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'ALLOCATING'::text, 'READY'::text, 'ACTIVE'::text, 'PAUSED'::text, 'DEGRADED'::text, 'TERMINATING'::text, 'TERMINATED'::text, 'FAILED'::text])))
);


--
-- Name: browser_worker_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_worker_projects (
    worker_id text NOT NULL,
    project_id text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_workers (
    id text NOT NULL,
    name text NOT NULL,
    credential_sha256 text NOT NULL,
    worker_version text NOT NULL,
    browser_type text NOT NULL,
    browser_version text NOT NULL,
    capacity integer NOT NULL,
    labels jsonb DEFAULT '[]'::jsonb NOT NULL,
    sandbox_enabled boolean NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone,
    active_sessions integer DEFAULT 0 NOT NULL,
    CONSTRAINT browser_workers_capacity_positive CHECK (((capacity >= 1) AND (capacity <= 64))),
    CONSTRAINT browser_workers_status_known CHECK ((status = ANY (ARRAY['active'::text, 'degraded'::text, 'lost'::text, 'revoked'::text])))
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    review_id text NOT NULL,
    finding_id text,
    body text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text,
    created_by_actor_display text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT comments_actor_type_known CHECK ((created_by_actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT comments_body_non_empty CHECK ((length(btrim(body)) > 0)),
    CONSTRAINT comments_revision_positive CHECK ((revision >= 1))
);


--
-- Name: connector_enrolment_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_enrolment_tokens (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text,
    token_hash text NOT NULL,
    environment_labels text[] DEFAULT '{}'::text[] NOT NULL,
    max_uses integer DEFAULT 1 NOT NULL,
    uses integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT connector_enrolment_tokens_max_uses_positive CHECK ((max_uses >= 1)),
    CONSTRAINT connector_enrolment_tokens_uses_bounded CHECK (((uses >= 0) AND (uses <= max_uses)))
);


--
-- Name: connector_tls_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_tls_material (
    purpose text NOT NULL,
    certificate_pem text NOT NULL,
    private_key_pem text NOT NULL,
    not_after timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connector_tls_material_purpose_known CHECK ((purpose = ANY (ARRAY['certificate_authority'::text, 'listener'::text])))
);


--
-- Name: connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connectors (
    id text NOT NULL,
    organisation_id text NOT NULL,
    environment_id text NOT NULL,
    project_id text,
    enrolment_token_id text,
    certificate_fingerprint text NOT NULL,
    certificate_serial text NOT NULL,
    certificate_not_after timestamp with time zone NOT NULL,
    public_key text NOT NULL,
    version text NOT NULL,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'PENDING_ENROLMENT'::text NOT NULL,
    connected_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connectors_status_known CHECK ((status = ANY (ARRAY['PENDING_ENROLMENT'::text, 'ACTIVE'::text, 'DEGRADED'::text, 'DISCONNECTED'::text, 'REVOKED'::text])))
);


--
-- Name: control_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.control_leases (
    id text NOT NULL,
    browser_session_id text NOT NULL,
    controller_type text NOT NULL,
    controller_id text NOT NULL,
    epoch integer NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    reason text,
    CONSTRAINT control_leases_controller_known CHECK ((controller_type = ANY (ARRAY['agent'::text, 'human'::text, 'system'::text]))),
    CONSTRAINT control_leases_epoch_non_negative CHECK ((epoch >= 0))
);


--
-- Name: environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environments (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text,
    name text NOT NULL,
    platform text NOT NULL,
    architecture text NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    trust_level text DEFAULT 'standard'::text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_streams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_streams (
    stream_key text NOT NULL,
    last_sequence bigint NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id text NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    stream_key text NOT NULL,
    sequence bigint NOT NULL,
    type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    organisation_id text NOT NULL,
    project_id text,
    actor_type text NOT NULL,
    actor_id text,
    actor_display text,
    correlation jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT events_actor_type_known CHECK ((actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text])))
);


--
-- Name: findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.findings (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    review_id text NOT NULL,
    title text NOT NULL,
    description text,
    severity text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    source text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text,
    created_by_actor_display text,
    claimed_by_actor_type text,
    claimed_by_actor_id text,
    claimed_by_actor_display text,
    url text NOT NULL,
    viewport jsonb NOT NULL,
    scroll_position jsonb NOT NULL,
    captured_commit text NOT NULL,
    screenshot_artefact_id text NOT NULL,
    element_context jsonb,
    acceptance_criteria text,
    resolution_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT findings_actor_type_known CHECK ((created_by_actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT findings_commit_shape CHECK ((captured_commit ~ '^[0-9a-f]{7,64}$'::text)),
    CONSTRAINT findings_scroll_shape CHECK (((jsonb_typeof(scroll_position) = 'object'::text) AND (jsonb_typeof((scroll_position -> 'x'::text)) = 'number'::text) AND (jsonb_typeof((scroll_position -> 'y'::text)) = 'number'::text))),
    CONSTRAINT findings_severity_known CHECK ((severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text, 'suggestion'::text]))),
    CONSTRAINT findings_source_known CHECK ((source = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT findings_status_known CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLAIMED'::text, 'IN_PROGRESS'::text, 'BLOCKED'::text, 'FIXED_UNVERIFIED'::text, 'AWAITING_HUMAN_REVIEW'::text, 'RESOLVED'::text, 'REOPENED'::text, 'WONT_FIX'::text, 'DUPLICATE'::text]))),
    CONSTRAINT findings_version_positive CHECK ((version >= 1)),
    CONSTRAINT findings_viewport_shape CHECK (((jsonb_typeof(viewport) = 'object'::text) AND (jsonb_typeof((viewport -> 'width'::text)) = 'number'::text) AND (jsonb_typeof((viewport -> 'height'::text)) = 'number'::text) AND (jsonb_typeof((viewport -> 'device_scale_factor'::text)) = 'number'::text)))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    project_id text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    tool text NOT NULL,
    key text NOT NULL,
    request_sha256 text NOT NULL,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT idempotency_actor_type_known CHECK ((actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT idempotency_digest_shape CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT idempotency_expiry_after_creation CHECK ((expires_at > created_at))
);


--
-- Name: organisations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organisations (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id text NOT NULL,
    organisation_id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: published_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.published_services (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    connector_id text NOT NULL,
    workspace_id text NOT NULL,
    public_alias text NOT NULL,
    local_host text NOT NULL,
    local_port integer NOT NULL,
    protocol text NOT NULL,
    scope text DEFAULT 'browser_session'::text NOT NULL,
    allowed_browser_session_ids text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    failure_class text,
    observed_destination text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    ended_at timestamp with time zone,
    CONSTRAINT published_services_allowed_browser_session_ids_check CHECK (((cardinality(allowed_browser_session_ids) >= 1) AND (cardinality(allowed_browser_session_ids) <= 32))),
    CONSTRAINT published_services_failure_class_only_when_failed CHECK (((status = 'failed'::text) OR (failure_class IS NULL))),
    CONSTRAINT published_services_local_port_check CHECK (((local_port >= 1) AND (local_port <= 65535))),
    CONSTRAINT published_services_protocol_check CHECK ((protocol = ANY (ARRAY['http'::text, 'https'::text]))),
    CONSTRAINT published_services_scope_check CHECK ((scope = 'browser_session'::text)),
    CONSTRAINT published_services_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'ready'::text, 'failed'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    priority text,
    version integer DEFAULT 1 NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text,
    created_by_actor_display text,
    assigned_user_id text,
    assigned_agent_session_id text,
    captured_branch text NOT NULL,
    captured_commit text NOT NULL,
    captured_workspace_id text NOT NULL,
    source_browser_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT reviews_actor_type_known CHECK ((created_by_actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT reviews_commit_shape CHECK ((captured_commit ~ '^[0-9a-f]{7,64}$'::text)),
    CONSTRAINT reviews_slug_shape CHECK (((slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text) AND (length(slug) <= 64))),
    CONSTRAINT reviews_status_known CHECK ((status = ANY (ARRAY['DRAFT'::text, 'READY'::text, 'ASSIGNED'::text, 'IN_PROGRESS'::text, 'AWAITING_HUMAN_REVIEW'::text, 'CHANGES_REQUESTED'::text, 'ACCEPTED'::text, 'CANCELLED'::text, 'ARCHIVED'::text]))),
    CONSTRAINT reviews_version_positive CHECK ((version >= 1))
);


--
-- Name: route_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_capabilities (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    published_service_id text NOT NULL,
    browser_session_id text NOT NULL,
    key_id text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT route_capabilities_check CHECK ((expires_at > issued_at))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verification_artefacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_artefacts (
    verification_id text NOT NULL,
    artefact_id text NOT NULL,
    role text NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT verification_artefacts_position_non_negative CHECK (("position" >= 0)),
    CONSTRAINT verification_artefacts_role_known CHECK ((role = ANY (ARRAY['before'::text, 'after'::text, 'supporting'::text])))
);


--
-- Name: verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verifications (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    review_id text NOT NULL,
    finding_id text NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    summary text NOT NULL,
    branch text NOT NULL,
    commit_sha text NOT NULL,
    tested_viewports jsonb NOT NULL,
    checks jsonb NOT NULL,
    submitted_by_actor_type text NOT NULL,
    submitted_by_actor_id text,
    submitted_by_actor_display text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by_actor_type text,
    reviewed_by_actor_id text,
    CONSTRAINT verifications_actor_type_known CHECK ((submitted_by_actor_type = ANY (ARRAY['human_user'::text, 'agent_session'::text, 'connector'::text, 'browser_worker'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT verifications_checks_are_an_object CHECK ((jsonb_typeof(checks) = 'object'::text)),
    CONSTRAINT verifications_commit_shape CHECK ((commit_sha ~ '^[0-9a-f]{7,64}$'::text)),
    CONSTRAINT verifications_decision_has_a_reviewer CHECK (((status = ANY (ARRAY['submitted'::text, 'superseded'::text])) OR ((reviewed_at IS NOT NULL) AND (reviewed_by_actor_type = 'human_user'::text)))),
    CONSTRAINT verifications_status_known CHECK ((status = ANY (ARRAY['submitted'::text, 'accepted'::text, 'rejected'::text, 'superseded'::text]))),
    CONSTRAINT verifications_viewports_are_a_list CHECK (((jsonb_typeof(tested_viewports) = 'array'::text) AND (jsonb_array_length(tested_viewports) >= 1)))
);


--
-- Name: viewer_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.viewer_sessions (
    id text NOT NULL,
    token_sha256 text NOT NULL,
    organisation_id text,
    project_ids text[],
    display text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT viewer_sessions_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT viewer_sessions_scope_non_empty CHECK (((project_ids IS NULL) OR (array_length(project_ids, 1) > 0)))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id text NOT NULL,
    organisation_id text NOT NULL,
    project_id text NOT NULL,
    connector_id text,
    root_path text NOT NULL,
    branch text NOT NULL,
    head_commit text NOT NULL,
    dirty boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    CONSTRAINT workspaces_commit_shape CHECK ((head_commit ~ '^[0-9a-f]{7,64}$'::text)),
    CONSTRAINT workspaces_root_path_absolute CHECK ((root_path <> ''::text))
);


--
-- Data for Name: agent_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.agent_credentials (id, token_sha256, organisation_id, project_ids, capabilities, label, issued_to_client, created_at, expires_at, last_used_at, revoked_at) VALUES ('agc_ms7xp0v4559c020ab07384d511a5', '1101ce8bbd8594d569e7db57f56ff53f30d5b39da7b73b669d989cda2e037a97', 'org_ms7xozk0b9886e8e6a6753affefa', '{prj_ms7xozk6bb5bbe67bf1f185f706d}', '{project:read,review:read,review:write,finding:read,finding:write,verification:submit,browser:capture}', 'claude-code on dev-ai-03', NULL, '2026-07-30 19:56:13.600594+00', '2026-07-30 20:56:13.6+00', '2026-07-30 19:56:14.145414+00', NULL);


--
-- Data for Name: agent_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.agent_sessions (id, organisation_id, project_id, credential_id, workspace_id, agent_type, agent_version, capabilities, client_capabilities, transport_session_id, branch, head_commit, status, started_at, last_seen_at, ended_at) VALUES ('ags_ms7xp0viabc88e7b2536361ea99e', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agc_ms7xp0v4559c020ab07384d511a5', 'wsp_ms7xp06z53c9a2aedf614b0a48fd', 'claude-code', 'stage0-fixture', '{project:read,review:read,review:write,finding:read,finding:write,verification:submit,browser:capture}', '{"resources": true, "image_content": true, "session_resume": false, "managed_messages": false}', '3679b58a-2300-461f-a6e5-05c2b8a96634', 'redesign', '4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60', 'ACTIVE', '2026-07-30 19:56:13.614921+00', '2026-07-30 19:56:13.614921+00', NULL);


--
-- Data for Name: annotations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.annotations (id, revision, organisation_id, project_id, finding_id, artefact_id, type, geometry, label, marker_number, style_hint, created_by_actor_type, created_by_actor_id, created_by_actor_display, created_at, deleted_at) VALUES ('ann_ms7xp0up89d65a4fffaf560bb94e', 1, 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'fin_ms7xp0una67e96ae314823d9e5db', 'art_ms7xp0jqfdba4a7459fa36f9565a', 'rectangle', '{"x": 0.05, "y": 0.02, "width": 0.9, "height": 0.2}', 'Heading text sits on top of the navigation links', 1, 'critical', 'human_user', 'bootstrap', 'bootstrap administrator', '2026-07-30 19:56:13.583669+00', NULL);
INSERT INTO public.annotations (id, revision, organisation_id, project_id, finding_id, artefact_id, type, geometry, label, marker_number, style_hint, created_by_actor_type, created_by_actor_id, created_by_actor_display, created_at, deleted_at) VALUES ('ann_ms7xp0us87bff478bfa891e49eab', 1, 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'fin_ms7xp0una67e96ae314823d9e5db', 'art_ms7xp0jqfdba4a7459fa36f9565a', 'arrow', '{"x": 0.62, "y": 0.28, "x2": 0.34, "y2": 0.09}', 'The Checkout link the heading covers', NULL, 'default', 'human_user', 'bootstrap', 'bootstrap administrator', '2026-07-30 19:56:13.583669+00', NULL);
INSERT INTO public.annotations (id, revision, organisation_id, project_id, finding_id, artefact_id, type, geometry, label, marker_number, style_hint, created_by_actor_type, created_by_actor_id, created_by_actor_display, created_at, deleted_at) VALUES ('ann_ms7xp0uz628926ea6f641f4d550d', 1, 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'fin_ms7xp0uyd2191a0bbe122c7b04d2', 'art_ms7xp0tn1ffc24eb3d6d16c2f614', 'numbered_marker', '{"x": 0.04, "y": 0.03}', 'Padding above the wordmark', 2, 'informational', 'human_user', 'bootstrap', 'bootstrap administrator', '2026-07-30 19:56:13.594562+00', NULL);


--
-- Data for Name: artefact_access_grants; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.artefact_access_grants (id, artefact_id, organisation_id, project_id, subject_type, subject_id, created_at, expires_at, revoked_at, last_used_at, use_count) VALUES ('agr_fDXP3r680tONqVQIskQpJdZ1fV5UevKq', 'art_ms7xp0jqfdba4a7459fa36f9565a', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', '2026-07-30 19:56:13.664618+00', '2026-07-30 19:58:13.664+00', NULL, NULL, 0);
INSERT INTO public.artefact_access_grants (id, artefact_id, organisation_id, project_id, subject_type, subject_id, created_at, expires_at, revoked_at, last_used_at, use_count) VALUES ('agr_f_bChMjVMPwzLZCfE7LWeLZ20Md0O2tj', 'art_ms7xp0tn1ffc24eb3d6d16c2f614', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', '2026-07-30 19:56:13.668644+00', '2026-07-30 19:58:13.668+00', NULL, NULL, 0);
INSERT INTO public.artefact_access_grants (id, artefact_id, organisation_id, project_id, subject_type, subject_id, created_at, expires_at, revoked_at, last_used_at, use_count) VALUES ('agr_YntJxJ8Dkr-i2fS_EJR6dEiAune9Qoxu', 'art_ms7xp17oddaeba25d7ed775adc0d', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', '2026-07-30 19:56:14.072841+00', '2026-07-30 19:58:14.072+00', NULL, NULL, 0);
INSERT INTO public.artefact_access_grants (id, artefact_id, organisation_id, project_id, subject_type, subject_id, created_at, expires_at, revoked_at, last_used_at, use_count) VALUES ('agr_ko6qy3Uz2BhSYXfaXPC8fHtQrjvPxAgH', 'art_ms7xp17oddaeba25d7ed775adc0d', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', '2026-07-30 19:56:14.104917+00', '2026-07-30 19:58:14.104+00', NULL, NULL, 0);
INSERT INTO public.artefact_access_grants (id, artefact_id, organisation_id, project_id, subject_type, subject_id, created_at, expires_at, revoked_at, last_used_at, use_count) VALUES ('agr_NCRxgb0qZ7-p1En1ueKlBOPTucj5Un26', 'art_ms7xp0jqfdba4a7459fa36f9565a', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', '2026-07-30 19:56:14.126555+00', '2026-07-30 19:58:14.126+00', NULL, NULL, 0);
INSERT INTO public.artefact_access_grants (id, artefact_id, organisation_id, project_id, subject_type, subject_id, created_at, expires_at, revoked_at, last_used_at, use_count) VALUES ('agr_ZC11jm06qwiF3bjt7zCm1rJmxhIvbslg', 'art_ms7xp0tn1ffc24eb3d6d16c2f614', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', '2026-07-30 19:56:14.129211+00', '2026-07-30 19:58:14.129+00', NULL, NULL, 0);


--
-- Data for Name: artefacts; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.artefacts (id, organisation_id, project_id, kind, state, storage_key, content_type, declared_size_bytes, declared_sha256, size_bytes, sha256, redaction_state, retention_class, browser_session_id, created_by_actor_type, created_by_actor_id, created_at, available_at, expires_at, content_width_px, content_height_px, filename_label) VALUES ('art_ms7xp0jqfdba4a7459fa36f9565a', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'screenshot', 'available', 'sha256/43/77b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66', 'image/png', 41099, '4377b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66', 41099, '4377b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66', 'not_applied', 'verification_evidence', 'brs_ms7xp0750bc4fbd521b90a4b9c7d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', '2026-07-30 19:56:13.190226+00', '2026-07-30 19:56:13.211503+00', NULL, 780, 1688, NULL);
INSERT INTO public.artefacts (id, organisation_id, project_id, kind, state, storage_key, content_type, declared_size_bytes, declared_sha256, size_bytes, sha256, redaction_state, retention_class, browser_session_id, created_by_actor_type, created_by_actor_id, created_at, available_at, expires_at, content_width_px, content_height_px, filename_label) VALUES ('art_ms7xp0tn1ffc24eb3d6d16c2f614', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'screenshot', 'available', 'sha256/c1/dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe', 'image/png', 22585, 'c1dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe', 22585, 'c1dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe', 'not_applied', 'verification_evidence', 'brs_ms7xp0kla981461df5e6836772a2', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', '2026-07-30 19:56:13.547038+00', '2026-07-30 19:56:13.565193+00', NULL, 1440, 900, NULL);
INSERT INTO public.artefacts (id, organisation_id, project_id, kind, state, storage_key, content_type, declared_size_bytes, declared_sha256, size_bytes, sha256, redaction_state, retention_class, browser_session_id, created_by_actor_type, created_by_actor_id, created_at, available_at, expires_at, content_width_px, content_height_px, filename_label) VALUES ('art_ms7xp17oddaeba25d7ed775adc0d', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'screenshot', 'available', 'sha256/50/cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430', 'image/png', 40777, '50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430', 40777, '50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430', 'not_applied', 'verification_evidence', 'brs_ms7xp0ylf9df0352538aa721d5e4', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', '2026-07-30 19:56:14.052027+00', '2026-07-30 19:56:14.066321+00', NULL, 780, 1688, NULL);


--
-- Data for Name: browser_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.browser_sessions (id, organisation_id, project_id, worker_id, agent_session_id, published_service_id, service_origin, browser_type, browser_version, status, current_controller_type, current_controller_id, control_epoch, last_sequence, viewport, limits, retention_policy, created_at, ended_at) VALUES ('brs_ms7xp0ylf9df0352538aa721d5e4', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'ags_ms7xp0viabc88e7b2536361ea99e', 'svc_2ed4942d077442e28b0fd03eca8b74a3', 'https://svc-6d5d9d173faa4fdb88345c1820fac470.internal.invalid', 'chromium', '151.0.7922.34', 'TERMINATED', 'agent', 'ags_ms7xp0viabc88e7b2536361ea99e', 1, 1, '{"width": 390, "height": 844, "device_scale_factor": 2}', '{"default_timeout_ms": 30000, "snapshot_max_bytes": 32768, "snapshot_max_nodes": 400, "max_duration_seconds": 7200, "screenshot_max_bytes": 20971520, "max_command_timeout_ms": 120000}', 'verification_evidence', '2026-07-30 19:56:13.725821+00', '2026-07-30 19:56:14.309567+00');
INSERT INTO public.browser_sessions (id, organisation_id, project_id, worker_id, agent_session_id, published_service_id, service_origin, browser_type, browser_version, status, current_controller_type, current_controller_id, control_epoch, last_sequence, viewport, limits, retention_policy, created_at, ended_at) VALUES ('brs_ms7xp0750bc4fbd521b90a4b9c7d', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'wkr_ms7xozkef3abf65e4f9256f277cd', NULL, 'svc_26d8d31d3edd42fe8c420c45e287b66d', 'https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid', 'chromium', '151.0.7922.34', 'TERMINATED', 'agent', 'ags_ms7xp072d6697a6adba4a928d964', 1, 1, '{"width": 390, "height": 844, "device_scale_factor": 2}', '{"default_timeout_ms": 30000, "snapshot_max_bytes": 32768, "snapshot_max_nodes": 400, "max_duration_seconds": 7200, "screenshot_max_bytes": 20971520, "max_command_timeout_ms": 120000}', 'verification_evidence', '2026-07-30 19:56:12.737653+00', '2026-07-30 19:56:14.199754+00');
INSERT INTO public.browser_sessions (id, organisation_id, project_id, worker_id, agent_session_id, published_service_id, service_origin, browser_type, browser_version, status, current_controller_type, current_controller_id, control_epoch, last_sequence, viewport, limits, retention_policy, created_at, ended_at) VALUES ('brs_ms7xp0kla981461df5e6836772a2', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'wkr_ms7xozkef3abf65e4f9256f277cd', NULL, 'svc_32c50d9f0d25407a8b40c66e4706fdf8', 'https://svc-e327c4efb3274eb0a1619fcc6cb35e6e.internal.invalid', 'chromium', '151.0.7922.34', 'TERMINATED', 'agent', 'ags_ms7xp0kj3b7f5a1d7269c1072f71', 1, 1, '{"width": 1440, "height": 900, "device_scale_factor": 1}', '{"default_timeout_ms": 30000, "snapshot_max_bytes": 32768, "snapshot_max_nodes": 400, "max_duration_seconds": 7200, "screenshot_max_bytes": 20971520, "max_command_timeout_ms": 120000}', 'verification_evidence', '2026-07-30 19:56:13.221757+00', '2026-07-30 19:56:14.258002+00');


--
-- Data for Name: browser_worker_projects; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.browser_worker_projects (worker_id, project_id, assigned_at) VALUES ('wkr_ms7xozkef3abf65e4f9256f277cd', 'prj_ms7xozk6bb5bbe67bf1f185f706d', '2026-07-30 19:56:11.923921+00');


--
-- Data for Name: browser_workers; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.browser_workers (id, name, credential_sha256, worker_version, browser_type, browser_version, capacity, labels, sandbox_enabled, status, registered_at, last_heartbeat_at, active_sessions) VALUES ('wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', 'c4bdfbf0c2400b35038e17326e055ef841e4008699d9dae98f6de20e2054a098', '0.1.0', 'chromium', 'chromium-bundled', 3, '["chromium"]', true, 'active', '2026-07-30 19:56:11.919235+00', '2026-07-30 19:56:12.558314+00', 0);


--
-- Data for Name: comments; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.comments (id, organisation_id, project_id, review_id, finding_id, body, revision, created_by_actor_type, created_by_actor_id, created_by_actor_display, created_at) VALUES ('cmt_ms7xp18j7c022fd91ac0d470a896', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'rev_ms7xp0ud798dfc9385a579d10d03', 'fin_ms7xp0una67e96ae314823d9e5db', 'Raised the navigation collapse breakpoint to 900px in the header stylesheet.', 1, 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '2026-07-30 19:56:14.083936+00');


--
-- Data for Name: connector_enrolment_tokens; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: connectors; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: control_leases; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.control_leases (id, browser_session_id, controller_type, controller_id, epoch, issued_at, expires_at, revoked_at, reason) VALUES ('lse_ms7xp077900caa2218f78f4055ad', 'brs_ms7xp0750bc4fbd521b90a4b9c7d', 'agent', 'ags_ms7xp072d6697a6adba4a928d964', 1, '2026-07-30 19:56:12.737653+00', '2026-07-30 20:11:12.737653+00', '2026-07-30 19:56:14.196256+00', 'terminated: requested');
INSERT INTO public.control_leases (id, browser_session_id, controller_type, controller_id, epoch, issued_at, expires_at, revoked_at, reason) VALUES ('lse_ms7xp0kn07e96cade0cf6345ce65', 'brs_ms7xp0kla981461df5e6836772a2', 'agent', 'ags_ms7xp0kj3b7f5a1d7269c1072f71', 1, '2026-07-30 19:56:13.221757+00', '2026-07-30 20:11:13.221757+00', '2026-07-30 19:56:14.251011+00', 'terminated: requested');
INSERT INTO public.control_leases (id, browser_session_id, controller_type, controller_id, epoch, issued_at, expires_at, revoked_at, reason) VALUES ('lse_ms7xp0yodb58fe30304a4e4ca00b', 'brs_ms7xp0ylf9df0352538aa721d5e4', 'agent', 'ags_ms7xp0viabc88e7b2536361ea99e', 1, '2026-07-30 19:56:13.725821+00', '2026-07-30 20:11:13.725821+00', '2026-07-30 19:56:14.30528+00', 'terminated: requested');


--
-- Data for Name: environments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: event_streams; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.event_streams (stream_key, last_sequence) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 72);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_7d8f0931f69e4089ba24c541537a04fa', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 1, 'project.created', '2026-07-30 19:56:11.913+00', '2026-07-30 19:56:11.91071+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{}', '{"slug": "refresh-surplus"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_75f61ba190ec4fcaa19d75e29e239998', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 2, 'browser_session.requested', '2026-07-30 19:56:12.741+00', '2026-07-30 19:56:12.737653+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"viewport": {"width": 390, "height": 844, "device_scale_factor": 2}, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_67f82eb7b32d400b8919b84d5027ec33', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 3, 'published_service.requested', '2026-07-30 19:56:12.744+00', '2026-07-30 19:56:12.744389+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'usr_bootstrap', 'Bootstrap administrator', '{"request_id": "req_19408zzr9wy", "connector_id": "con_fixture", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d"}', '{"protocol": "http", "expires_at": "2026-07-30T20:11:12.744Z", "local_host": "127.0.0.1", "local_port": 4321, "new_status": "requested", "connector_id": "con_fixture", "public_alias": "svc-ad923cc25ab248c6bbe31ce641fa7760", "workspace_id": "wsp_fixture", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d", "allowed_browser_session_ids": ["brs_ms7xp0750bc4fbd521b90a4b9c7d"]}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_3ae556612bc74ee18e0bc0c845645e47', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 4, 'published_service.ready', '2026-07-30 19:56:12.75+00', '2026-07-30 19:56:12.749096+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'usr_bootstrap', 'Bootstrap administrator', '{"request_id": "req_19408zzr9wy", "connector_id": "con_fixture", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d"}', '{"new_status": "ready", "internal_origin": "https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/", "previous_status": "requested", "connector_connected": true, "observed_destination": "127.0.0.1:4321", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_1ccda4cc83a34a93bdfa219a91f88486', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 5, 'published_service.ready', '2026-07-30 19:56:12.755+00', '2026-07-30 19:56:12.755956+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"request_id": "req_llbwxtf1ai", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d"}', '{"key_id": "test-a", "expires_at": "2026-07-30T20:01:12.755Z", "capability_id": "cap_e8d6aa21d02446ffa27333eed4870526", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_029a0baf044d4d8a908cdef7be775af5', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 6, 'browser_session.allocated', '2026-07-30 19:56:12.761+00', '2026-07-30 19:56:12.760999+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "new_status": "ALLOCATING", "previous_status": "REQUESTED", "published_service_id": "svc_26d8d31d3edd42fe8c420c45e287b66d"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_b4460770f5994dbaa467dd8bf214da48', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 7, 'browser_session.ready', '2026-07-30 19:56:12.985+00', '2026-07-30 19:56:12.980989+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"new_status": "READY", "browser_type": "chromium", "browser_version": "151.0.7922.34", "previous_status": "ALLOCATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_6b2628cc7cd54572a866ba61f59a1ee0', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 8, 'browser_session.ready', '2026-07-30 19:56:13.012+00', '2026-07-30 19:56:13.010691+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"reason": "isolated context allocated", "new_status": "READY", "reported_by": "browser_worker", "previous_status": "READY"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_297bccddf0ea4b4c9450d7dde96a7849', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 9, 'browser.command_executed', '2026-07-30 19:56:13.104+00', '2026-07-30 19:56:13.102126+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"command": "navigate", "sequence": 0, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_c580ee7ea3ea40de9537e31ec9dc22b0', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 10, 'browser_session.navigated', '2026-07-30 19:56:13.105+00', '2026-07-30 19:56:13.102126+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"url": "https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/", "trust": "untrusted_browser_content", "http_status": 200}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_b8f48ba6f7cc4c1eb3a5935ccee546eb', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 11, 'artefact.upload_started', '2026-07-30 19:56:13.194+00', '2026-07-30 19:56:13.190226+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"kind": "screenshot", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "content_type": "image/png", "declared_sha256": "4377b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66", "declared_size_bytes": 41099}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_63ee5756acd043b8a5da3d8cc4845545', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 12, 'artefact.upload_completed', '2026-07-30 19:56:13.212+00', '2026-07-30 19:56:13.211503+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"kind": "screenshot", "sha256": "4377b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66", "size_bytes": 41099, "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "storage_key": "sha256/43/77b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66", "redaction_state": "not_applied", "content_rectangle": {"width_px": 780, "height_px": 1688}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_bcd8b0807c5047fea6bf20b76142599b', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 13, 'screenshot.captured', '2026-07-30 19:56:13.213+00', '2026-07-30 19:56:13.211503+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"sha256": "4377b7be6795c14126745f66afe245f159c7d38cc4fe25620abca3bc3efd5f66", "size_bytes": 41099, "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "content_rectangle": {"width_px": 780, "height_px": 1688}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_0b8e6448c149491cbf4930d1708a4e62', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 14, 'browser.command_executed', '2026-07-30 19:56:13.217+00', '2026-07-30 19:56:13.216986+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"command": "take_screenshot", "sequence": 1, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f171b7bf92184918b36d5710ca8771dd', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 15, 'browser_session.requested', '2026-07-30 19:56:13.225+00', '2026-07-30 19:56:13.221757+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"viewport": {"width": 1440, "height": 900, "device_scale_factor": 1}, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_c067f506519f4fc081feaec1a80536b6', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 16, 'published_service.requested', '2026-07-30 19:56:13.226+00', '2026-07-30 19:56:13.22671+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'usr_bootstrap', 'Bootstrap administrator', '{"request_id": "req_oruz4azc6h", "connector_id": "con_fixture", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8"}', '{"protocol": "http", "expires_at": "2026-07-30T20:11:13.226Z", "local_host": "127.0.0.1", "local_port": 4321, "new_status": "requested", "connector_id": "con_fixture", "public_alias": "svc-e327c4efb3274eb0a1619fcc6cb35e6e", "workspace_id": "wsp_fixture", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8", "allowed_browser_session_ids": ["brs_ms7xp0kla981461df5e6836772a2"]}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_bc20115711244961930aff0b7ed08122', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 17, 'published_service.ready', '2026-07-30 19:56:13.231+00', '2026-07-30 19:56:13.230614+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'usr_bootstrap', 'Bootstrap administrator', '{"request_id": "req_oruz4azc6h", "connector_id": "con_fixture", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8"}', '{"new_status": "ready", "internal_origin": "https://svc-e327c4efb3274eb0a1619fcc6cb35e6e.internal.invalid/", "previous_status": "requested", "connector_connected": true, "observed_destination": "127.0.0.1:4321", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_73f8b5ad5742414a8e5fa860acea65f6', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 18, 'published_service.ready', '2026-07-30 19:56:13.235+00', '2026-07-30 19:56:13.236067+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"request_id": "req_i0ny9oodfrm", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8"}', '{"key_id": "test-a", "expires_at": "2026-07-30T20:01:13.235Z", "capability_id": "cap_2c779ffcb91741689bd2844aa482d281", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f67bdd45c9fa463a9dbbc953cfe57d90', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 19, 'browser_session.allocated', '2026-07-30 19:56:13.24+00', '2026-07-30 19:56:13.239418+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "new_status": "ALLOCATING", "previous_status": "REQUESTED", "published_service_id": "svc_32c50d9f0d25407a8b40c66e4706fdf8"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_2ec787f49f8e44009d48d3756a9fd308', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 20, 'browser_session.ready', '2026-07-30 19:56:13.378+00', '2026-07-30 19:56:13.377229+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"new_status": "READY", "browser_type": "chromium", "browser_version": "151.0.7922.34", "previous_status": "ALLOCATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_79eb0dc78f764a0c91fd5cca95727380', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 37, 'artefact.access_granted', '2026-07-30 19:56:13.666+00', '2026-07-30 19:56:13.664618+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}', '{"subject": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "grant_id": "agr_fDXP3r680tONqVQIskQpJdZ1fV5UevKq", "expires_at": "2026-07-30T19:58:13.664Z", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_5fbc37804f164e1da25b04178fef18d9', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 38, 'artefact.access_granted', '2026-07-30 19:56:13.669+00', '2026-07-30 19:56:13.668644+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614"}', '{"subject": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "grant_id": "agr_f_bChMjVMPwzLZCfE7LWeLZ20Md0O2tj", "expires_at": "2026-07-30T19:58:13.668Z", "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_160ba08d775542a182d82da30adf9947', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 39, 'review.claimed', '2026-07-30 19:56:13.683+00', '2026-07-30 19:56:13.681122+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "agent_session_id": "ags_ms7xp0viabc88e7b2536361ea99e"}', '{"version": 2, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "claimed_by": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_eba6aee7367f4af49d8a5bda63c2119e', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 40, 'review.status_changed', '2026-07-30 19:56:13.684+00', '2026-07-30 19:56:13.681122+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}', '{"to": "ASSIGNED", "from": "READY", "version": 2, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_9cc29ceabaef4049ac0eaf33573e664d', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 41, 'finding.claimed', '2026-07-30 19:56:13.696+00', '2026-07-30 19:56:13.693856+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}', '{"version": 2, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "claimed_by": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_fc94cf25585e4e70a386cb0e7f546d22', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 42, 'finding.status_changed', '2026-07-30 19:56:13.697+00', '2026-07-30 19:56:13.693856+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}', '{"to": "CLAIMED", "from": "OPEN", "source": "human", "version": 2, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_d3e2eedd3b524ee49ac81c24b917e52e', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 43, 'finding.status_changed', '2026-07-30 19:56:13.707+00', '2026-07-30 19:56:13.705616+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}', '{"to": "IN_PROGRESS", "from": "CLAIMED", "source": "human", "version": 3, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_10624a7c15bd419c975506f18b439e26', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 21, 'browser_session.ready', '2026-07-30 19:56:13.382+00', '2026-07-30 19:56:13.378333+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"reason": "isolated context allocated", "new_status": "READY", "reported_by": "browser_worker", "previous_status": "ALLOCATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_1e4da394151e42e59f0a78ee6f0b243f', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 22, 'browser.command_executed', '2026-07-30 19:56:13.489+00', '2026-07-30 19:56:13.488707+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"command": "navigate", "sequence": 0, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_d646d0a6733d41788b56f80b31098940', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 23, 'browser_session.navigated', '2026-07-30 19:56:13.491+00', '2026-07-30 19:56:13.488707+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"url": "https://svc-e327c4efb3274eb0a1619fcc6cb35e6e.internal.invalid/", "trust": "untrusted_browser_content", "http_status": 200}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_ce0c9892aa584482882c2fc039c05ff4', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 24, 'artefact.upload_started', '2026-07-30 19:56:13.549+00', '2026-07-30 19:56:13.547038+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"kind": "screenshot", "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "content_type": "image/png", "declared_sha256": "c1dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe", "declared_size_bytes": 22585}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_3a00d64a74bf438c9a2877f87e41665d', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 25, 'artefact.upload_completed', '2026-07-30 19:56:13.566+00', '2026-07-30 19:56:13.565193+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"kind": "screenshot", "sha256": "c1dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe", "size_bytes": 22585, "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "storage_key": "sha256/c1/dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe", "redaction_state": "not_applied", "content_rectangle": {"width_px": 1440, "height_px": 900}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_5e40dbc32eaa451e8e7aa181cde73e20', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 26, 'screenshot.captured', '2026-07-30 19:56:13.567+00', '2026-07-30 19:56:13.565193+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"sha256": "c1dde412d399ffdd219636dfcdfcdac7730eb10dcd946cf1db8bbc25b1f69ffe", "size_bytes": 22585, "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "content_rectangle": {"width_px": 1440, "height_px": 900}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_0ab5f36c2212434a87c49b8ef6dc0ba1', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 27, 'browser.command_executed', '2026-07-30 19:56:13.57+00', '2026-07-30 19:56:13.570349+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"command": "take_screenshot", "sequence": 1, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_d919e9519b224c448020519071d72876', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 28, 'review.created', '2026-07-30 19:56:13.577+00', '2026-07-30 19:56:13.574218+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"review": {"id": "rev_ms7xp0ud798dfc9385a579d10d03", "slug": "bugs-on-homepage", "title": "Bugs on homepage", "status": "READY", "version": 1, "created_at": "2026-07-30T19:56:13.574Z", "created_by": {"id": "bootstrap", "type": "human_user", "display": "bootstrap administrator"}, "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "updated_at": "2026-07-30T19:56:13.574Z", "description": "Two layout problems a customer reported on the homepage of the redesign branch.", "finding_count": 0, "captured_branch": "redesign", "captured_commit": "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60", "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa", "captured_workspace_id": "wsp_ms7xp06z53c9a2aedf614b0a48fd", "source_browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_2c04f3a1b0cb4dd7992982845a0d2700', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 29, 'review.named', '2026-07-30 19:56:13.578+00', '2026-07-30 19:56:13.574218+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}', '{"slug": "bugs-on-homepage", "title": "Bugs on homepage", "review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_0ca8eb9ba0b447fa8c3b55a1cb81f73c', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 30, 'finding.created', '2026-07-30 19:56:13.589+00', '2026-07-30 19:56:13.583669+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}', '{"finding": {"id": "fin_ms7xp0una67e96ae314823d9e5db", "url": "https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/", "title": "Hero heading overlaps the navigation below 900px", "source": "human", "status": "OPEN", "version": 1, "severity": "high", "viewport": {"width": 390, "height": 844, "device_scale_factor": 2}, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "created_at": "2026-07-30T19:56:13.583Z", "created_by": {"id": "bootstrap", "type": "human_user", "display": "bootstrap administrator"}, "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "updated_at": "2026-07-30T19:56:13.583Z", "description": "The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.", "captured_commit": "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60", "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa", "scroll_position": {"x": 0, "y": 0}, "annotation_count": 2, "acceptance_criteria": "No overlap between 768px and 1024px.", "screenshot_artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_b4b0cc49e74d4370aab21806bfad0c38', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 44, 'browser_session.requested', '2026-07-30 19:56:13.731+00', '2026-07-30 19:56:13.725821+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"viewport": {"width": 390, "height": 844, "device_scale_factor": 2}, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_fe776e9427274523afdfb12b1316dd1d', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 31, 'finding.annotated', '2026-07-30 19:56:13.59+00', '2026-07-30 19:56:13.583669+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "annotation_id": "ann_ms7xp0up89d65a4fffaf560bb94e"}', '{"annotation": {"id": "ann_ms7xp0up89d65a4fffaf560bb94e", "type": "rectangle", "label": "Heading text sits on top of the navigation links", "geometry": {"x": 0.05, "y": 0.02, "width": 0.9, "height": 0.2}, "revision": 1, "created_at": "2026-07-30T19:56:13.583Z", "created_by": {"id": "bootstrap", "type": "human_user", "display": "bootstrap administrator"}, "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "style_hint": "critical", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "marker_number": 1, "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_728605b6f441469aa6413e86896d5809', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 32, 'finding.annotated', '2026-07-30 19:56:13.591+00', '2026-07-30 19:56:13.583669+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "annotation_id": "ann_ms7xp0us87bff478bfa891e49eab"}', '{"annotation": {"id": "ann_ms7xp0us87bff478bfa891e49eab", "type": "arrow", "label": "The Checkout link the heading covers", "geometry": {"x": 0.62, "y": 0.28, "x2": 0.34, "y2": 0.09}, "revision": 1, "created_at": "2026-07-30T19:56:13.583Z", "created_by": {"id": "bootstrap", "type": "human_user", "display": "bootstrap administrator"}, "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "style_hint": "default", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a", "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f298ec6e61e44752aed40cb36b241c7a', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 33, 'finding.created', '2026-07-30 19:56:13.597+00', '2026-07-30 19:56:13.594562+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0uyd2191a0bbe122c7b04d2", "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614"}', '{"finding": {"id": "fin_ms7xp0uyd2191a0bbe122c7b04d2", "url": "https://svc-e327c4efb3274eb0a1619fcc6cb35e6e.internal.invalid/", "title": "Header padding is uneven at 1440px", "source": "human", "status": "OPEN", "version": 1, "severity": "medium", "viewport": {"width": 1440, "height": 900, "device_scale_factor": 1}, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "created_at": "2026-07-30T19:56:13.594Z", "created_by": {"id": "bootstrap", "type": "human_user", "display": "bootstrap administrator"}, "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "updated_at": "2026-07-30T19:56:13.594Z", "description": "The header keeps its mobile padding on a wide viewport, so the wordmark sits closer to the top edge than to the navigation.", "captured_commit": "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60", "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa", "scroll_position": {"x": 0, "y": 0}, "annotation_count": 1, "acceptance_criteria": "Equal padding above and below the wordmark at 1440px.", "screenshot_artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_e79d778fe78c47409fd2533824efe0ef', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 34, 'finding.annotated', '2026-07-30 19:56:13.598+00', '2026-07-30 19:56:13.594562+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'bootstrap', 'bootstrap administrator', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0uyd2191a0bbe122c7b04d2", "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "annotation_id": "ann_ms7xp0uz628926ea6f641f4d550d"}', '{"annotation": {"id": "ann_ms7xp0uz628926ea6f641f4d550d", "type": "numbered_marker", "label": "Padding above the wordmark", "geometry": {"x": 0.04, "y": 0.03}, "revision": 1, "created_at": "2026-07-30T19:56:13.594Z", "created_by": {"id": "bootstrap", "type": "human_user", "display": "bootstrap administrator"}, "finding_id": "fin_ms7xp0uyd2191a0bbe122c7b04d2", "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "style_hint": "informational", "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614", "marker_number": 2, "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_51044a30f5bd46799fc00bccc7bde984', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 35, 'agent_credential.issued', '2026-07-30 19:56:13.602+00', '2026-07-30 19:56:13.601948+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{}', '{"label": "claude-code on dev-ai-03", "expires_at": "2026-07-30T20:56:13.600Z", "project_ids": ["prj_ms7xozk6bb5bbe67bf1f185f706d"], "capabilities": ["project:read", "review:read", "review:write", "finding:read", "finding:write", "verification:submit", "browser:capture"], "credential_id": "agc_ms7xp0v4559c020ab07384d511a5"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_597517b1ec3d4b6abfb86bddab58d336', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 36, 'agent_session.started', '2026-07-30 19:56:13.617+00', '2026-07-30 19:56:13.614921+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code stage0-fixture', '{"agent_session_id": "ags_ms7xp0viabc88e7b2536361ea99e"}', '{"agent_type": "claude-code", "capabilities": ["project:read", "review:read", "review:write", "finding:read", "finding:write", "verification:submit", "browser:capture"], "workspace_id": "wsp_ms7xp06z53c9a2aedf614b0a48fd", "agent_version": "stage0-fixture", "credential_id": "agc_ms7xp0v4559c020ab07384d511a5", "agent_session_id": "ags_ms7xp0viabc88e7b2536361ea99e", "client_capabilities": {"resources": true, "image_content": true, "session_resume": false, "managed_messages": false}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_63deec3eed0f4401aaf0c88e54b850af', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 50, 'browser_session.ready', '2026-07-30 19:56:13.872+00', '2026-07-30 19:56:13.870377+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"reason": "isolated context allocated", "new_status": "READY", "reported_by": "browser_worker", "previous_status": "ALLOCATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_74402cdf2a274cf5ad72e69028def349', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 51, 'browser.command_executed', '2026-07-30 19:56:13.977+00', '2026-07-30 19:56:13.976439+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"command": "navigate", "sequence": 0, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_b3182948e913450d8b4bea74ae952f80', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 52, 'browser_session.navigated', '2026-07-30 19:56:13.978+00', '2026-07-30 19:56:13.976439+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"url": "https://svc-6d5d9d173faa4fdb88345c1820fac470.internal.invalid/", "trust": "untrusted_browser_content", "http_status": 200}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_2c18124d5b134bdeb587e361071b6bc2', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 45, 'published_service.requested', '2026-07-30 19:56:13.739+00', '2026-07-30 19:56:13.739661+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'usr_bootstrap', 'Bootstrap administrator', '{"request_id": "req_ksmcc2jorze", "connector_id": "con_fixture", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3"}', '{"protocol": "http", "expires_at": "2026-07-30T20:11:13.739Z", "local_host": "127.0.0.1", "local_port": 4321, "new_status": "requested", "connector_id": "con_fixture", "public_alias": "svc-6d5d9d173faa4fdb88345c1820fac470", "workspace_id": "wsp_fixture", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3", "allowed_browser_session_ids": ["brs_ms7xp0ylf9df0352538aa721d5e4"]}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_23b4dd39e2a84b348d72b7aea16ccc41', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 46, 'published_service.ready', '2026-07-30 19:56:13.742+00', '2026-07-30 19:56:13.742033+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', 'usr_bootstrap', 'Bootstrap administrator', '{"request_id": "req_ksmcc2jorze", "connector_id": "con_fixture", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3"}', '{"new_status": "ready", "internal_origin": "https://svc-6d5d9d173faa4fdb88345c1820fac470.internal.invalid/", "previous_status": "requested", "connector_connected": true, "observed_destination": "127.0.0.1:4321", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_c6980635dedc4bf0b254b73db63289ec', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 47, 'published_service.ready', '2026-07-30 19:56:13.745+00', '2026-07-30 19:56:13.745962+00', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"request_id": "req_pbci78kacsp", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3"}', '{"key_id": "test-a", "expires_at": "2026-07-30T20:01:13.745Z", "capability_id": "cap_1f57524848354927be3b43d4ae5b2ab3", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_b70c287519214ef8816476bd197ed154', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 48, 'browser_session.allocated', '2026-07-30 19:56:13.749+00', '2026-07-30 19:56:13.748773+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "new_status": "ALLOCATING", "previous_status": "REQUESTED", "published_service_id": "svc_2ed4942d077442e28b0fd03eca8b74a3"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_49c9655989f544f9aaab53dbbf0151f9', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 49, 'browser_session.ready', '2026-07-30 19:56:13.87+00', '2026-07-30 19:56:13.867978+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"new_status": "READY", "browser_type": "chromium", "browser_version": "151.0.7922.34", "previous_status": "ALLOCATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f4ded1cab2d8431a8e3a93d3ca2a7378', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 53, 'artefact.upload_started', '2026-07-30 19:56:14.053+00', '2026-07-30 19:56:14.052027+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"kind": "screenshot", "artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "content_type": "image/png", "declared_sha256": "50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430", "declared_size_bytes": 40777}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_20d9f2f2d95f412c8a3ad16cd32f6dc6', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 54, 'artefact.upload_completed', '2026-07-30 19:56:14.067+00', '2026-07-30 19:56:14.066321+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"kind": "screenshot", "sha256": "50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430", "size_bytes": 40777, "artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "storage_key": "sha256/50/cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430", "redaction_state": "not_applied", "content_rectangle": {"width_px": 780, "height_px": 1688}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_867adb08eaf34afebe0ef01f547b8459', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 55, 'screenshot.captured', '2026-07-30 19:56:14.068+00', '2026-07-30 19:56:14.066321+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"sha256": "50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430", "size_bytes": 40777, "artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "content_rectangle": {"width_px": 780, "height_px": 1688}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f6b20735be684247899cad8ba3965406', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 56, 'browser.command_executed', '2026-07-30 19:56:14.07+00', '2026-07-30 19:56:14.070493+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"command": "take_screenshot", "sequence": 1, "control_epoch": 1}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_cee08840149f4371b2b1673c1204d8b5', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 57, 'artefact.access_granted', '2026-07-30 19:56:14.073+00', '2026-07-30 19:56:14.072841+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d"}', '{"subject": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "grant_id": "agr_YntJxJ8Dkr-i2fS_EJR6dEiAune9Qoxu", "expires_at": "2026-07-30T19:58:14.072Z", "artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_8cff2fb5fc04421689aa7aaf349189bb', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 58, 'finding.comment_added', '2026-07-30 19:56:14.086+00', '2026-07-30 19:56:14.083936+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}', '{"comment": {"id": "cmt_ms7xp18j7c022fd91ac0d470a896", "body": "Raised the navigation collapse breakpoint to 900px in the header stylesheet.", "revision": 1, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "created_at": "2026-07-30T19:56:14.083Z", "created_by": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "project_id": "prj_ms7xozk6bb5bbe67bf1f185f706d", "organisation_id": "org_ms7xozk0b9886e8e6a6753affefa"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_1f4bf9b12ff147e7bbad3ba9d2654286', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 68, 'browser_session.terminated', '2026-07-30 19:56:14.201+00', '2026-07-30 19:56:14.199754+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"reason": "terminated: requested", "new_status": "TERMINATED", "reported_by": "browser_worker", "previous_status": "TERMINATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_91a436af910b41158c47b9101ab451ba', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 59, 'finding.verification_submitted', '2026-07-30 19:56:14.102+00', '2026-07-30 19:56:14.09708+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "agent_session_id": "ags_ms7xp0viabc88e7b2536361ea99e"}', '{"verification": {"branch": "redesign", "checks": {"reproduced_before": true, "accessibility_checked": true, "console_errors_reviewed": true, "network_failures_reviewed": true}, "commit": "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6", "status": "submitted", "summary": "Raised the navigation collapse breakpoint to 900px so the heading no longer overlaps the links.", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db", "artefact_ids": ["art_ms7xp17oddaeba25d7ed775adc0d"], "submitted_at": "2026-07-30T19:56:14.097Z", "submitted_by": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "verification_id": "ver_ms7xp18w8f424e2974f3752945dc", "tested_viewports": [{"width": 390, "height": 844, "device_scale_factor": 2}, {"width": 1440, "height": 900, "device_scale_factor": 1}], "after_artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d", "before_artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_cd0600ddc6f74341942b5c4485f594b0', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 60, 'finding.status_changed', '2026-07-30 19:56:14.103+00', '2026-07-30 19:56:14.09708+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}', '{"to": "FIXED_UNVERIFIED", "from": "IN_PROGRESS", "reason": "Verification submitted with evidence.", "source": "human", "version": 4, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f69e32bb37284502ac2cb74121029815', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 61, 'artefact.access_granted', '2026-07-30 19:56:14.105+00', '2026-07-30 19:56:14.104917+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d"}', '{"subject": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "grant_id": "agr_ko6qy3Uz2BhSYXfaXPC8fHtQrjvPxAgH", "expires_at": "2026-07-30T19:58:14.104Z", "artefact_id": "art_ms7xp17oddaeba25d7ed775adc0d"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_9e10319a00c34034ba1a7254f6d1107d', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 62, 'finding.status_changed', '2026-07-30 19:56:14.116+00', '2026-07-30 19:56:14.114789+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}', '{"to": "AWAITING_HUMAN_REVIEW", "from": "FIXED_UNVERIFIED", "source": "human", "version": 5, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03", "finding_id": "fin_ms7xp0una67e96ae314823d9e5db"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_98ca2494e7e54fffb35c982416a8f5dc', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 63, 'artefact.access_granted', '2026-07-30 19:56:14.127+00', '2026-07-30 19:56:14.126555+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}', '{"subject": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "grant_id": "agr_NCRxgb0qZ7-p1En1ueKlBOPTucj5Un26", "expires_at": "2026-07-30T19:58:14.126Z", "artefact_id": "art_ms7xp0jqfdba4a7459fa36f9565a"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_ed63ac5129c5401d8bfb43e9dde43839', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 64, 'artefact.access_granted', '2026-07-30 19:56:14.13+00', '2026-07-30 19:56:14.129211+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614"}', '{"subject": {"id": "ags_ms7xp0viabc88e7b2536361ea99e", "type": "agent_session", "display": "claude-code"}, "grant_id": "agr_ZC11jm06qwiF3bjt7zCm1rJmxhIvbslg", "expires_at": "2026-07-30T19:58:14.129Z", "artefact_id": "art_ms7xp0tn1ffc24eb3d6d16c2f614"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_097f4f1f441847fdb3d6454da71d8415', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 65, 'review.status_changed', '2026-07-30 19:56:14.14+00', '2026-07-30 19:56:14.138458+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}', '{"to": "IN_PROGRESS", "from": "ASSIGNED", "version": 3, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_c802ce0a83b04dada2a5059cf3c21fd3', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 66, 'review.status_changed', '2026-07-30 19:56:14.149+00', '2026-07-30 19:56:14.14786+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '{"review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}', '{"to": "AWAITING_HUMAN_REVIEW", "from": "IN_PROGRESS", "version": 4, "review_id": "rev_ms7xp0ud798dfc9385a579d10d03"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_c39569d642da4119ac79411e8314c10f', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 67, 'browser_session.terminated', '2026-07-30 19:56:14.198+00', '2026-07-30 19:56:14.19782+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0750bc4fbd521b90a4b9c7d"}', '{"reason": "requested", "new_status": "TERMINATED", "previous_status": "TERMINATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_28feb17f0f024238a7b41f6dc04b1fe3', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 69, 'browser_session.terminated', '2026-07-30 19:56:14.257+00', '2026-07-30 19:56:14.252428+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"reason": "requested", "new_status": "TERMINATED", "previous_status": "TERMINATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_142b6948f6964d518c628b54f44fb081', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 72, 'browser_session.terminated', '2026-07-30 19:56:14.311+00', '2026-07-30 19:56:14.309567+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"reason": "terminated: requested", "new_status": "TERMINATED", "reported_by": "browser_worker", "previous_status": "TERMINATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_f6c3051d2fc84c39b8cbffb75d929855', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 70, 'browser_session.terminated', '2026-07-30 19:56:14.262+00', '2026-07-30 19:56:14.258002+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'browser_worker', 'wkr_ms7xozkef3abf65e4f9256f277cd', 'browser-worker-01', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0kla981461df5e6836772a2"}', '{"reason": "terminated: requested", "new_status": "TERMINATED", "reported_by": "browser_worker", "previous_status": "TERMINATING"}');
INSERT INTO public.events (id, schema_version, stream_key, sequence, type, occurred_at, recorded_at, organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload) VALUES ('evt_288555e73e354cc19aa457408fbda18a', 1, 'prj_ms7xozk6bb5bbe67bf1f185f706d', 71, 'browser_session.terminated', '2026-07-30 19:56:14.308+00', '2026-07-30 19:56:14.306932+00', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'human_user', NULL, 'bootstrap administrator', '{"worker_id": "wkr_ms7xozkef3abf65e4f9256f277cd", "browser_session_id": "brs_ms7xp0ylf9df0352538aa721d5e4"}', '{"reason": "requested", "new_status": "TERMINATED", "previous_status": "TERMINATING"}');


--
-- Data for Name: findings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.findings (id, organisation_id, project_id, review_id, title, description, severity, status, source, version, created_by_actor_type, created_by_actor_id, created_by_actor_display, claimed_by_actor_type, claimed_by_actor_id, claimed_by_actor_display, url, viewport, scroll_position, captured_commit, screenshot_artefact_id, element_context, acceptance_criteria, resolution_note, created_at, updated_at) VALUES ('fin_ms7xp0uyd2191a0bbe122c7b04d2', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'rev_ms7xp0ud798dfc9385a579d10d03', 'Header padding is uneven at 1440px', 'The header keeps its mobile padding on a wide viewport, so the wordmark sits closer to the top edge than to the navigation.', 'medium', 'OPEN', 'human', 1, 'human_user', 'bootstrap', 'bootstrap administrator', NULL, NULL, NULL, 'https://svc-e327c4efb3274eb0a1619fcc6cb35e6e.internal.invalid/', '{"width": 1440, "height": 900, "device_scale_factor": 1}', '{"x": 0, "y": 0}', '4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60', 'art_ms7xp0tn1ffc24eb3d6d16c2f614', NULL, 'Equal padding above and below the wordmark at 1440px.', NULL, '2026-07-30 19:56:13.594562+00', '2026-07-30 19:56:13.594562+00');
INSERT INTO public.findings (id, organisation_id, project_id, review_id, title, description, severity, status, source, version, created_by_actor_type, created_by_actor_id, created_by_actor_display, claimed_by_actor_type, claimed_by_actor_id, claimed_by_actor_display, url, viewport, scroll_position, captured_commit, screenshot_artefact_id, element_context, acceptance_criteria, resolution_note, created_at, updated_at) VALUES ('fin_ms7xp0una67e96ae314823d9e5db', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'rev_ms7xp0ud798dfc9385a579d10d03', 'Hero heading overlaps the navigation below 900px', 'The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.', 'high', 'AWAITING_HUMAN_REVIEW', 'human', 5, 'human_user', 'bootstrap', 'bootstrap administrator', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', 'https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/', '{"width": 390, "height": 844, "device_scale_factor": 2}', '{"x": 0, "y": 0}', '4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60', 'art_ms7xp0jqfdba4a7459fa36f9565a', NULL, 'No overlap between 768px and 1024px.', 'Raised the navigation collapse breakpoint to 900px so the heading no longer overlaps the links.', '2026-07-30 19:56:13.583669+00', '2026-07-30 19:56:14.114789+00');


--
-- Data for Name: idempotency_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'review_claim', 'fixture-claim-review', '2f70c22c372b46e640f09c32578d3435ec9c29c68ae4a9e18018abd2d45d9bd3', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_a85cced1c7a84935a00ad3c5982c6723\",\"type\":\"review_claim\",\"trust\":\"trusted_human_instruction\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"review\":{\"id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"project_id\":\"prj_ms7xozk6bb5bbe67bf1f185f706d\",\"slug\":\"bugs-on-homepage\",\"title\":\"Bugs on homepage\",\"description\":\"Two layout problems a customer reported on the homepage of the redesign branch.\",\"status\":\"ASSIGNED\",\"version\":2,\"captured_branch\":\"redesign\",\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"captured_workspace_id\":\"wsp_ms7xp06z53c9a2aedf614b0a48fd\",\"source_browser_session_id\":\"brs_ms7xp0750bc4fbd521b90a4b9c7d\",\"finding_count\":0,\"resource_uri\":\"review://refresh-surplus/bugs-on-homepage\",\"created_at\":\"2026-07-30T19:56:13.574Z\",\"updated_at\":\"2026-07-30T19:56:13.681Z\"},\"previous_status\":\"READY\"}}"}', '2026-07-30 19:56:13.678763+00', '2026-07-30 19:56:13.685553+00', '2026-07-31 19:56:13.678+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'finding_claim', 'fixture-claim-finding', '20c8260d1dbbf6e57f48aa3d31af928e073e1ea5b0d2f6859e9d0c8c93df586d', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_f872cfd60e8d41cfabe3a1ad6555beb0\",\"type\":\"finding_claim\",\"trust\":\"mixed\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"finding\":{\"id\":\"fin_ms7xp0una67e96ae314823d9e5db\",\"review_id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"title\":\"Hero heading overlaps the navigation below 900px\",\"description\":\"The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.\",\"severity\":\"high\",\"status\":\"CLAIMED\",\"source\":\"human\",\"version\":2,\"url\":\"https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/\",\"viewport\":{\"width\":390,\"height\":844,\"device_scale_factor\":2},\"scroll_position\":{\"x\":0,\"y\":0},\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"screenshot_artefact_id\":\"art_ms7xp0jqfdba4a7459fa36f9565a\",\"acceptance_criteria\":\"No overlap between 768px and 1024px.\",\"claimed_by\":{\"type\":\"agent_session\",\"id\":\"ags_ms7xp0viabc88e7b2536361ea99e\",\"display\":\"claude-code\"},\"resource_uri\":\"finding://fin_ms7xp0una67e96ae314823d9e5db\",\"untrusted_fields\":[\"url\"]},\"previous_status\":\"OPEN\"}}"}', '2026-07-30 19:56:13.692054+00', '2026-07-30 19:56:13.698173+00', '2026-07-31 19:56:13.691+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'finding_update_status', 'fixture-in-progress', '057b639358017c125aea438d71da3b98208e29f5b9cad6c54533276bc6a26623', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_8697cadf7dac450c95396fcf5bff8a7f\",\"type\":\"finding_update_status\",\"trust\":\"mixed\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"finding\":{\"id\":\"fin_ms7xp0una67e96ae314823d9e5db\",\"review_id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"title\":\"Hero heading overlaps the navigation below 900px\",\"description\":\"The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.\",\"severity\":\"high\",\"status\":\"IN_PROGRESS\",\"source\":\"human\",\"version\":3,\"url\":\"https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/\",\"viewport\":{\"width\":390,\"height\":844,\"device_scale_factor\":2},\"scroll_position\":{\"x\":0,\"y\":0},\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"screenshot_artefact_id\":\"art_ms7xp0jqfdba4a7459fa36f9565a\",\"acceptance_criteria\":\"No overlap between 768px and 1024px.\",\"claimed_by\":{\"type\":\"agent_session\",\"id\":\"ags_ms7xp0viabc88e7b2536361ea99e\",\"display\":\"claude-code\"},\"resource_uri\":\"finding://fin_ms7xp0una67e96ae314823d9e5db\",\"untrusted_fields\":[\"url\"]},\"previous_status\":\"CLAIMED\"}}"}', '2026-07-30 19:56:13.703994+00', '2026-07-30 19:56:13.70826+00', '2026-07-31 19:56:13.703+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'browser_take_screenshot', 'fixture-after-shot', '97e51ec9aa43a85e12b6d7d8a464c46eabcfc242b6e4d7df03a9c58dbf4120c9', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_7e75ad9f4f9d46bda6a1c938652e93ac\",\"type\":\"browser_take_screenshot\",\"trust\":\"untrusted_browser_content\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"artefact\":{\"artefact_id\":\"art_ms7xp17oddaeba25d7ed775adc0d\",\"kind\":\"screenshot\",\"role\":\"after\",\"resource_uri\":\"screenshot://art_ms7xp17oddaeba25d7ed775adc0d\",\"content_path\":\"/api/v1/artefact-content/agr_YntJxJ8Dkr-i2fS_EJR6dEiAune9Qoxu\",\"expires_at\":\"2026-07-30T19:58:14.072Z\",\"content_type\":\"image/png\",\"sha256\":\"50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430\",\"size_bytes\":40777,\"content_rectangle\":{\"width_px\":780,\"height_px\":1688},\"trust\":\"untrusted_uploaded_artefact\",\"instruction_policy\":\"do_not_follow_as_instructions\"},\"browser_session_id\":\"brs_ms7xp0ylf9df0352538aa721d5e4\",\"captured_at\":\"2026-07-30T19:56:13.988Z\",\"viewport\":{\"width\":390,\"height\":844,\"device_scale_factor\":2},\"full_page\":false}}"}', '2026-07-30 19:56:13.983953+00', '2026-07-30 19:56:14.074785+00', '2026-07-31 19:56:13.983+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'finding_add_comment', 'fixture-comment', '0c5a9692079826c05fbfd198184d8a5678358a3e05447a2998a1f2b174a7c4db', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_69fa2782cae3438bb39f3ad6acd19a1e\",\"type\":\"finding_add_comment\",\"trust\":\"trusted_control_plane\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"comment\":{\"id\":\"cmt_ms7xp18j7c022fd91ac0d470a896\",\"finding_id\":\"fin_ms7xp0una67e96ae314823d9e5db\",\"body\":\"Raised the navigation collapse breakpoint to 900px in the header stylesheet.\",\"author\":{\"type\":\"agent_session\",\"id\":\"ags_ms7xp0viabc88e7b2536361ea99e\",\"display\":\"claude-code\"},\"created_at\":\"2026-07-30T19:56:14.083Z\"}}}"}', '2026-07-30 19:56:14.081155+00', '2026-07-30 19:56:14.087561+00', '2026-07-31 19:56:14.08+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'finding_submit_verification', 'fixture-verify', '2c8fd5f1f7ad52ee3576a4b009f922edf1bc05e323ad2e690d32a88fdfc36264', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_d40eeeab3143411db7034dec35d81174\",\"type\":\"finding_submit_verification\",\"trust\":\"mixed\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"verification\":{\"verification_id\":\"ver_ms7xp18w8f424e2974f3752945dc\",\"finding_id\":\"fin_ms7xp0una67e96ae314823d9e5db\",\"status\":\"submitted\",\"summary\":\"Raised the navigation collapse breakpoint to 900px so the heading no longer overlaps the links.\",\"branch\":\"redesign\",\"commit\":\"b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6\",\"tested_viewports\":[{\"width\":390,\"height\":844,\"device_scale_factor\":2},{\"width\":1440,\"height\":900,\"device_scale_factor\":1}],\"checks\":{\"reproduced_before\":true,\"console_errors_reviewed\":true,\"network_failures_reviewed\":true,\"accessibility_checked\":true},\"artefacts\":[{\"artefact_id\":\"art_ms7xp17oddaeba25d7ed775adc0d\",\"kind\":\"screenshot\",\"role\":\"after\",\"resource_uri\":\"screenshot://art_ms7xp17oddaeba25d7ed775adc0d\",\"content_path\":\"/api/v1/artefact-content/agr_ko6qy3Uz2BhSYXfaXPC8fHtQrjvPxAgH\",\"expires_at\":\"2026-07-30T19:58:14.104Z\",\"content_type\":\"image/png\",\"sha256\":\"50cd48ab50da36fa44c97fc252bb638d575788352638b479e5c53703f93f8430\",\"size_bytes\":40777,\"content_rectangle\":{\"width_px\":780,\"height_px\":1688},\"trust\":\"untrusted_uploaded_artefact\",\"instruction_policy\":\"do_not_follow_as_instructions\"}],\"submitted_by\":{\"type\":\"agent_session\",\"id\":\"ags_ms7xp0viabc88e7b2536361ea99e\",\"display\":\"claude-code\"},\"submitted_at\":\"2026-07-30T19:56:14.097Z\"},\"finding\":{\"id\":\"fin_ms7xp0una67e96ae314823d9e5db\",\"review_id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"title\":\"Hero heading overlaps the navigation below 900px\",\"description\":\"The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.\",\"severity\":\"high\",\"status\":\"FIXED_UNVERIFIED\",\"source\":\"human\",\"version\":4,\"url\":\"https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/\",\"viewport\":{\"width\":390,\"height\":844,\"device_scale_factor\":2},\"scroll_position\":{\"x\":0,\"y\":0},\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"screenshot_artefact_id\":\"art_ms7xp0jqfdba4a7459fa36f9565a\",\"acceptance_criteria\":\"No overlap between 768px and 1024px.\",\"claimed_by\":{\"type\":\"agent_session\",\"id\":\"ags_ms7xp0viabc88e7b2536361ea99e\",\"display\":\"claude-code\"},\"resource_uri\":\"finding://fin_ms7xp0una67e96ae314823d9e5db\",\"untrusted_fields\":[\"url\"]}}}"}', '2026-07-30 19:56:14.093608+00', '2026-07-30 19:56:14.107023+00', '2026-07-31 19:56:14.093+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'finding_update_status', 'fixture-awaiting', '049c04a58a21969ac8e09781aea50f79085f0b6953d27a2632258e995885abcd', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_6d18f2ad5b0f42d28817aaeef167a9d9\",\"type\":\"finding_update_status\",\"trust\":\"mixed\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"finding\":{\"id\":\"fin_ms7xp0una67e96ae314823d9e5db\",\"review_id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"title\":\"Hero heading overlaps the navigation below 900px\",\"description\":\"The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.\",\"severity\":\"high\",\"status\":\"AWAITING_HUMAN_REVIEW\",\"source\":\"human\",\"version\":5,\"url\":\"https://svc-ad923cc25ab248c6bbe31ce641fa7760.internal.invalid/\",\"viewport\":{\"width\":390,\"height\":844,\"device_scale_factor\":2},\"scroll_position\":{\"x\":0,\"y\":0},\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"screenshot_artefact_id\":\"art_ms7xp0jqfdba4a7459fa36f9565a\",\"acceptance_criteria\":\"No overlap between 768px and 1024px.\",\"claimed_by\":{\"type\":\"agent_session\",\"id\":\"ags_ms7xp0viabc88e7b2536361ea99e\",\"display\":\"claude-code\"},\"resource_uri\":\"finding://fin_ms7xp0una67e96ae314823d9e5db\",\"untrusted_fields\":[\"url\"]},\"previous_status\":\"FIXED_UNVERIFIED\"}}"}', '2026-07-30 19:56:14.113399+00', '2026-07-30 19:56:14.117427+00', '2026-07-31 19:56:14.113+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'review_update_status', 'fixture-review-in-progress', 'dcaba482abd375646ce7ef4043a71b81dcad622c44367cc082800efa5e11fd72', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_456e7220abd941979d99516cc7fb5b99\",\"type\":\"review_update_status\",\"trust\":\"trusted_human_instruction\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"review\":{\"id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"project_id\":\"prj_ms7xozk6bb5bbe67bf1f185f706d\",\"slug\":\"bugs-on-homepage\",\"title\":\"Bugs on homepage\",\"description\":\"Two layout problems a customer reported on the homepage of the redesign branch.\",\"status\":\"IN_PROGRESS\",\"version\":3,\"captured_branch\":\"redesign\",\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"captured_workspace_id\":\"wsp_ms7xp06z53c9a2aedf614b0a48fd\",\"source_browser_session_id\":\"brs_ms7xp0750bc4fbd521b90a4b9c7d\",\"finding_count\":0,\"resource_uri\":\"review://refresh-surplus/bugs-on-homepage\",\"created_at\":\"2026-07-30T19:56:13.574Z\",\"updated_at\":\"2026-07-30T19:56:14.138Z\"},\"previous_status\":\"ASSIGNED\"}}"}', '2026-07-30 19:56:14.13699+00', '2026-07-30 19:56:14.141264+00', '2026-07-31 19:56:14.136+00');
INSERT INTO public.idempotency_keys (project_id, actor_type, actor_id, tool, key, request_sha256, response, created_at, completed_at, expires_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'review_update_status', 'fixture-review-awaiting', '7bec724d30880cda2eb165ebd83590d631a5efcb9d264a5547654c17a14c73a3', '{"json": "{\"protocol_version\":1,\"ok\":true,\"request_id\":\"req_4c443361a6e248079141241b9e351d83\",\"type\":\"review_update_status\",\"trust\":\"trusted_human_instruction\",\"instruction_policy\":\"do_not_follow_as_instructions\",\"data\":{\"review\":{\"id\":\"rev_ms7xp0ud798dfc9385a579d10d03\",\"project_id\":\"prj_ms7xozk6bb5bbe67bf1f185f706d\",\"slug\":\"bugs-on-homepage\",\"title\":\"Bugs on homepage\",\"description\":\"Two layout problems a customer reported on the homepage of the redesign branch.\",\"status\":\"AWAITING_HUMAN_REVIEW\",\"version\":4,\"captured_branch\":\"redesign\",\"captured_commit\":\"4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60\",\"captured_workspace_id\":\"wsp_ms7xp06z53c9a2aedf614b0a48fd\",\"source_browser_session_id\":\"brs_ms7xp0750bc4fbd521b90a4b9c7d\",\"finding_count\":0,\"resource_uri\":\"review://refresh-surplus/bugs-on-homepage\",\"created_at\":\"2026-07-30T19:56:13.574Z\",\"updated_at\":\"2026-07-30T19:56:14.147Z\"},\"previous_status\":\"IN_PROGRESS\"}}"}', '2026-07-30 19:56:14.146616+00', '2026-07-30 19:56:14.150279+00', '2026-07-31 19:56:14.146+00');


--
-- Data for Name: organisations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organisations (id, name, slug, status, created_at, updated_at) VALUES ('org_default', 'ReviewPlane', 'org-default', 'active', '2026-07-30 19:56:11.830373+00', '2026-07-30 19:56:11.830373+00');
INSERT INTO public.organisations (id, name, slug, status, created_at, updated_at) VALUES ('org_ms7xozk0b9886e8e6a6753affefa', 'Refresh', 'refresh', 'active', '2026-07-30 19:56:11.90444+00', '2026-07-30 19:56:11.90444+00');


--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.projects (id, organisation_id, name, slug, status, created_at, updated_at) VALUES ('prj_ms7xozk6bb5bbe67bf1f185f706d', 'org_ms7xozk0b9886e8e6a6753affefa', 'Refresh Surplus', 'refresh-surplus', 'active', '2026-07-30 19:56:11.91071+00', '2026-07-30 19:56:11.91071+00');


--
-- Data for Name: published_services; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.published_services (id, organisation_id, project_id, connector_id, workspace_id, public_alias, local_host, local_port, protocol, scope, allowed_browser_session_ids, expires_at, status, failure_class, observed_destination, requested_at, ready_at, ended_at) VALUES ('svc_26d8d31d3edd42fe8c420c45e287b66d', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'con_fixture', 'wsp_fixture', 'svc-ad923cc25ab248c6bbe31ce641fa7760', '127.0.0.1', 4321, 'http', 'browser_session', '{brs_ms7xp0750bc4fbd521b90a4b9c7d}', '2026-07-30 20:11:12.744+00', 'ready', NULL, '127.0.0.1:4321', '2026-07-30 19:56:12.744389+00', '2026-07-30 19:56:12.749096+00', NULL);
INSERT INTO public.published_services (id, organisation_id, project_id, connector_id, workspace_id, public_alias, local_host, local_port, protocol, scope, allowed_browser_session_ids, expires_at, status, failure_class, observed_destination, requested_at, ready_at, ended_at) VALUES ('svc_32c50d9f0d25407a8b40c66e4706fdf8', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'con_fixture', 'wsp_fixture', 'svc-e327c4efb3274eb0a1619fcc6cb35e6e', '127.0.0.1', 4321, 'http', 'browser_session', '{brs_ms7xp0kla981461df5e6836772a2}', '2026-07-30 20:11:13.226+00', 'ready', NULL, '127.0.0.1:4321', '2026-07-30 19:56:13.22671+00', '2026-07-30 19:56:13.230614+00', NULL);
INSERT INTO public.published_services (id, organisation_id, project_id, connector_id, workspace_id, public_alias, local_host, local_port, protocol, scope, allowed_browser_session_ids, expires_at, status, failure_class, observed_destination, requested_at, ready_at, ended_at) VALUES ('svc_2ed4942d077442e28b0fd03eca8b74a3', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'con_fixture', 'wsp_fixture', 'svc-6d5d9d173faa4fdb88345c1820fac470', '127.0.0.1', 4321, 'http', 'browser_session', '{brs_ms7xp0ylf9df0352538aa721d5e4}', '2026-07-30 20:11:13.739+00', 'ready', NULL, '127.0.0.1:4321', '2026-07-30 19:56:13.739661+00', '2026-07-30 19:56:13.742033+00', NULL);


--
-- Data for Name: reviews; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.reviews (id, organisation_id, project_id, slug, title, description, status, priority, version, created_by_actor_type, created_by_actor_id, created_by_actor_display, assigned_user_id, assigned_agent_session_id, captured_branch, captured_commit, captured_workspace_id, source_browser_session_id, created_at, updated_at, closed_at) VALUES ('rev_ms7xp0ud798dfc9385a579d10d03', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'bugs-on-homepage', 'Bugs on homepage', 'Two layout problems a customer reported on the homepage of the redesign branch.', 'AWAITING_HUMAN_REVIEW', NULL, 4, 'human_user', 'bootstrap', 'bootstrap administrator', NULL, 'ags_ms7xp0viabc88e7b2536361ea99e', 'redesign', '4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60', 'wsp_ms7xp06z53c9a2aedf614b0a48fd', 'brs_ms7xp0750bc4fbd521b90a4b9c7d', '2026-07-30 19:56:13.574218+00', '2026-07-30 19:56:14.14786+00', NULL);


--
-- Data for Name: route_capabilities; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.route_capabilities (id, organisation_id, project_id, published_service_id, browser_session_id, key_id, issued_at, expires_at, revoked_at) VALUES ('cap_e8d6aa21d02446ffa27333eed4870526', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'svc_26d8d31d3edd42fe8c420c45e287b66d', 'brs_ms7xp0750bc4fbd521b90a4b9c7d', 'test-a', '2026-07-30 19:56:12.755+00', '2026-07-30 20:01:12.755+00', NULL);
INSERT INTO public.route_capabilities (id, organisation_id, project_id, published_service_id, browser_session_id, key_id, issued_at, expires_at, revoked_at) VALUES ('cap_2c779ffcb91741689bd2844aa482d281', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'svc_32c50d9f0d25407a8b40c66e4706fdf8', 'brs_ms7xp0kla981461df5e6836772a2', 'test-a', '2026-07-30 19:56:13.235+00', '2026-07-30 20:01:13.235+00', NULL);
INSERT INTO public.route_capabilities (id, organisation_id, project_id, published_service_id, browser_session_id, key_id, issued_at, expires_at, revoked_at) VALUES ('cap_1f57524848354927be3b43d4ae5b2ab3', 'org_default', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'svc_2ed4942d077442e28b0fd03eca8b74a3', 'brs_ms7xp0ylf9df0352538aa721d5e4', 'test-a', '2026-07-30 19:56:13.745+00', '2026-07-30 20:01:13.745+00', NULL);


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0001_events.sql', '2026-07-30 19:56:11.465022+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0002_organisations_and_projects.sql', '2026-07-30 19:56:11.48683+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0003_connectors.sql', '2026-07-30 19:56:11.51184+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0020_published_services.sql', '2026-07-30 19:56:11.545245+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0021_route_capabilities.sql', '2026-07-30 19:56:11.555908+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0042_browser_workers.sql', '2026-07-30 19:56:11.564609+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0043_browser_sessions.sql', '2026-07-30 19:56:11.579105+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0044_artefacts.sql', '2026-07-30 19:56:11.599679+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0045_viewer_sessions.sql', '2026-07-30 19:56:11.615252+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0046_reviews.sql', '2026-07-30 19:56:11.62384+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0047_findings.sql', '2026-07-30 19:56:11.637511+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0048_annotations.sql', '2026-07-30 19:56:11.655679+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0049_artefact_metadata_and_grants.sql', '2026-07-30 19:56:11.675073+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0050_agent_credentials.sql', '2026-07-30 19:56:11.689611+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0051_workspaces.sql', '2026-07-30 19:56:11.700113+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0052_agent_sessions.sql', '2026-07-30 19:56:11.71041+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0053_comments_and_verifications.sql', '2026-07-30 19:56:11.728126+00');
INSERT INTO public.schema_migrations (filename, applied_at) VALUES ('0054_idempotency_keys.sql', '2026-07-30 19:56:11.759733+00');


--
-- Data for Name: verification_artefacts; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.verification_artefacts (verification_id, artefact_id, role, "position") VALUES ('ver_ms7xp18w8f424e2974f3752945dc', 'art_ms7xp17oddaeba25d7ed775adc0d', 'after', 0);


--
-- Data for Name: verifications; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.verifications (id, organisation_id, project_id, review_id, finding_id, status, summary, branch, commit_sha, tested_viewports, checks, submitted_by_actor_type, submitted_by_actor_id, submitted_by_actor_display, submitted_at, reviewed_at, reviewed_by_actor_type, reviewed_by_actor_id) VALUES ('ver_ms7xp18w8f424e2974f3752945dc', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', 'rev_ms7xp0ud798dfc9385a579d10d03', 'fin_ms7xp0una67e96ae314823d9e5db', 'submitted', 'Raised the navigation collapse breakpoint to 900px so the heading no longer overlaps the links.', 'redesign', 'b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6', '[{"width": 390, "height": 844, "device_scale_factor": 2}, {"width": 1440, "height": 900, "device_scale_factor": 1}]', '{"reproduced_before": true, "accessibility_checked": true, "console_errors_reviewed": true, "network_failures_reviewed": true}', 'agent_session', 'ags_ms7xp0viabc88e7b2536361ea99e', 'claude-code', '2026-07-30 19:56:14.09708+00', NULL, NULL, NULL);


--
-- Data for Name: viewer_sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspaces; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.workspaces (id, organisation_id, project_id, connector_id, root_path, branch, head_commit, dirty, created_at, updated_at, last_seen_at) VALUES ('wsp_ms7xp06z53c9a2aedf614b0a48fd', 'org_ms7xozk0b9886e8e6a6753affefa', 'prj_ms7xozk6bb5bbe67bf1f185f706d', NULL, '/workspace/refresh-surplus', 'redesign', '4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60', false, '2026-07-30 19:56:12.731895+00', '2026-07-30 19:56:12.731895+00', '2026-07-30 19:56:12.731895+00');


--
-- Name: agent_credentials agent_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_pkey PRIMARY KEY (id);


--
-- Name: agent_credentials agent_credentials_token_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_token_sha256_key UNIQUE (token_sha256);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions agent_sessions_transport_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_transport_session_id_key UNIQUE (transport_session_id);


--
-- Name: annotations annotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_pkey PRIMARY KEY (id, revision);


--
-- Name: artefact_access_grants artefact_access_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefact_access_grants
    ADD CONSTRAINT artefact_access_grants_pkey PRIMARY KEY (id);


--
-- Name: artefacts artefacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefacts
    ADD CONSTRAINT artefacts_pkey PRIMARY KEY (id);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: browser_worker_projects browser_worker_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_worker_projects
    ADD CONSTRAINT browser_worker_projects_pkey PRIMARY KEY (worker_id, project_id);


--
-- Name: browser_workers browser_workers_credential_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_workers
    ADD CONSTRAINT browser_workers_credential_sha256_key UNIQUE (credential_sha256);


--
-- Name: browser_workers browser_workers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_workers
    ADD CONSTRAINT browser_workers_name_key UNIQUE (name);


--
-- Name: browser_workers browser_workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_workers
    ADD CONSTRAINT browser_workers_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: connector_enrolment_tokens connector_enrolment_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_enrolment_tokens
    ADD CONSTRAINT connector_enrolment_tokens_pkey PRIMARY KEY (id);


--
-- Name: connector_enrolment_tokens connector_enrolment_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_enrolment_tokens
    ADD CONSTRAINT connector_enrolment_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: connector_tls_material connector_tls_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_tls_material
    ADD CONSTRAINT connector_tls_material_pkey PRIMARY KEY (purpose);


--
-- Name: connectors connectors_certificate_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_certificate_fingerprint_key UNIQUE (certificate_fingerprint);


--
-- Name: connectors connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_pkey PRIMARY KEY (id);


--
-- Name: control_leases control_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_leases
    ADD CONSTRAINT control_leases_pkey PRIMARY KEY (id);


--
-- Name: environments environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);


--
-- Name: event_streams event_streams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_streams
    ADD CONSTRAINT event_streams_pkey PRIMARY KEY (stream_key);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: events events_stream_sequence_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_stream_sequence_unique UNIQUE (stream_key, sequence);


--
-- Name: findings findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (project_id, actor_type, actor_id, tool, key);


--
-- Name: organisations organisations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_pkey PRIMARY KEY (id);


--
-- Name: organisations organisations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_slug_key UNIQUE (slug);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_slug_unique_per_organisation; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slug_unique_per_organisation UNIQUE (organisation_id, slug);


--
-- Name: published_services published_services_alias_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.published_services
    ADD CONSTRAINT published_services_alias_unique UNIQUE (public_alias);


--
-- Name: published_services published_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.published_services
    ADD CONSTRAINT published_services_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: route_capabilities route_capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_capabilities
    ADD CONSTRAINT route_capabilities_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: verification_artefacts verification_artefacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_artefacts
    ADD CONSTRAINT verification_artefacts_pkey PRIMARY KEY (verification_id, artefact_id);


--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);


--
-- Name: viewer_sessions viewer_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_sessions
    ADD CONSTRAINT viewer_sessions_pkey PRIMARY KEY (id);


--
-- Name: viewer_sessions viewer_sessions_token_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_sessions
    ADD CONSTRAINT viewer_sessions_token_sha256_key UNIQUE (token_sha256);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_root_unique_per_project; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_root_unique_per_project UNIQUE (project_id, root_path);


--
-- Name: agent_credentials_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_credentials_expiry_idx ON public.agent_credentials USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: agent_credentials_organisation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_credentials_organisation_idx ON public.agent_credentials USING btree (organisation_id);


--
-- Name: agent_sessions_credential_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_sessions_credential_idx ON public.agent_sessions USING btree (credential_id);


--
-- Name: agent_sessions_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_sessions_project_idx ON public.agent_sessions USING btree (project_id, started_at DESC);


--
-- Name: annotations_artefact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX annotations_artefact_idx ON public.annotations USING btree (artefact_id);


--
-- Name: annotations_finding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX annotations_finding_idx ON public.annotations USING btree (finding_id, created_at);


--
-- Name: artefact_grants_artefact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artefact_grants_artefact_idx ON public.artefact_access_grants USING btree (artefact_id);


--
-- Name: artefact_grants_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artefact_grants_expiry_idx ON public.artefact_access_grants USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: artefacts_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artefacts_project_idx ON public.artefacts USING btree (project_id, created_at DESC);


--
-- Name: artefacts_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artefacts_session_idx ON public.artefacts USING btree (browser_session_id);


--
-- Name: browser_sessions_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_project_idx ON public.browser_sessions USING btree (project_id, created_at DESC);


--
-- Name: browser_sessions_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_worker_idx ON public.browser_sessions USING btree (worker_id) WHERE (ended_at IS NULL);


--
-- Name: comments_finding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_finding_idx ON public.comments USING btree (finding_id, created_at);


--
-- Name: comments_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_review_idx ON public.comments USING btree (review_id, created_at);


--
-- Name: connector_enrolment_tokens_organisation_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX connector_enrolment_tokens_organisation_index ON public.connector_enrolment_tokens USING btree (organisation_id);


--
-- Name: connectors_organisation_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX connectors_organisation_index ON public.connectors USING btree (organisation_id);


--
-- Name: connectors_status_heartbeat_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX connectors_status_heartbeat_index ON public.connectors USING btree (status, last_heartbeat_at);


--
-- Name: control_leases_epoch_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX control_leases_epoch_unique ON public.control_leases USING btree (browser_session_id, epoch);


--
-- Name: control_leases_one_active_interactive; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX control_leases_one_active_interactive ON public.control_leases USING btree (browser_session_id) WHERE ((revoked_at IS NULL) AND (controller_type <> 'system'::text));


--
-- Name: environments_organisation_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environments_organisation_index ON public.environments USING btree (organisation_id);


--
-- Name: events_organisation_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_organisation_index ON public.events USING btree (organisation_id, occurred_at);


--
-- Name: events_project_sequence_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_project_sequence_index ON public.events USING btree (project_id, sequence DESC);


--
-- Name: events_stream_sequence_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_stream_sequence_index ON public.events USING btree (stream_key, sequence DESC);


--
-- Name: events_type_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_type_index ON public.events USING btree (type, recorded_at DESC);


--
-- Name: findings_artefact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX findings_artefact_idx ON public.findings USING btree (screenshot_artefact_id);


--
-- Name: findings_project_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX findings_project_status_idx ON public.findings USING btree (project_id, status);


--
-- Name: findings_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX findings_review_idx ON public.findings USING btree (review_id, created_at);


--
-- Name: idempotency_keys_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_expiry_idx ON public.idempotency_keys USING btree (expires_at);


--
-- Name: projects_organisation_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_organisation_index ON public.projects USING btree (organisation_id);


--
-- Name: published_services_connector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX published_services_connector_idx ON public.published_services USING btree (connector_id) WHERE (status = 'ready'::text);


--
-- Name: published_services_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX published_services_expiry_idx ON public.published_services USING btree (expires_at) WHERE (status = 'ready'::text);


--
-- Name: published_services_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX published_services_project_idx ON public.published_services USING btree (project_id, status);


--
-- Name: reviews_active_slug_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reviews_active_slug_unique ON public.reviews USING btree (project_id, slug) WHERE (status <> ALL (ARRAY['CANCELLED'::text, 'ARCHIVED'::text]));


--
-- Name: reviews_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_project_idx ON public.reviews USING btree (project_id, created_at DESC);


--
-- Name: reviews_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_session_idx ON public.reviews USING btree (source_browser_session_id);


--
-- Name: route_capabilities_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX route_capabilities_live_idx ON public.route_capabilities USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: route_capabilities_service_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX route_capabilities_service_idx ON public.route_capabilities USING btree (published_service_id, browser_session_id);


--
-- Name: verification_artefacts_artefact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_artefacts_artefact_idx ON public.verification_artefacts USING btree (artefact_id);


--
-- Name: verifications_finding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verifications_finding_idx ON public.verifications USING btree (finding_id, submitted_at DESC);


--
-- Name: verifications_project_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verifications_project_status_idx ON public.verifications USING btree (project_id, status);


--
-- Name: viewer_sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX viewer_sessions_expiry_idx ON public.viewer_sessions USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: workspaces_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_project_idx ON public.workspaces USING btree (project_id);


--
-- Name: agent_credentials agent_credentials_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.agent_credentials(id) ON DELETE RESTRICT;


--
-- Name: agent_sessions agent_sessions_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: agent_sessions agent_sessions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: agent_sessions agent_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: annotations annotations_artefact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_artefact_id_fkey FOREIGN KEY (artefact_id) REFERENCES public.artefacts(id) ON DELETE RESTRICT;


--
-- Name: annotations annotations_finding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES public.findings(id) ON DELETE CASCADE;


--
-- Name: annotations annotations_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: annotations annotations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: artefact_access_grants artefact_access_grants_artefact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefact_access_grants
    ADD CONSTRAINT artefact_access_grants_artefact_id_fkey FOREIGN KEY (artefact_id) REFERENCES public.artefacts(id) ON DELETE CASCADE;


--
-- Name: artefact_access_grants artefact_access_grants_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefact_access_grants
    ADD CONSTRAINT artefact_access_grants_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: artefact_access_grants artefact_access_grants_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefact_access_grants
    ADD CONSTRAINT artefact_access_grants_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: artefacts artefacts_browser_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefacts
    ADD CONSTRAINT artefacts_browser_session_id_fkey FOREIGN KEY (browser_session_id) REFERENCES public.browser_sessions(id) ON DELETE SET NULL;


--
-- Name: artefacts artefacts_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefacts
    ADD CONSTRAINT artefacts_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: artefacts artefacts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artefacts
    ADD CONSTRAINT artefacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: browser_sessions browser_sessions_agent_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_agent_session_fk FOREIGN KEY (agent_session_id) REFERENCES public.agent_sessions(id) ON DELETE SET NULL;


--
-- Name: browser_sessions browser_sessions_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: browser_sessions browser_sessions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: browser_sessions browser_sessions_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.browser_workers(id) ON DELETE SET NULL;


--
-- Name: browser_worker_projects browser_worker_projects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_worker_projects
    ADD CONSTRAINT browser_worker_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: browser_worker_projects browser_worker_projects_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_worker_projects
    ADD CONSTRAINT browser_worker_projects_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.browser_workers(id) ON DELETE CASCADE;


--
-- Name: comments comments_finding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES public.findings(id) ON DELETE CASCADE;


--
-- Name: comments comments_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: comments comments_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: comments comments_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.reviews(id) ON DELETE CASCADE;


--
-- Name: connector_enrolment_tokens connector_enrolment_tokens_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_enrolment_tokens
    ADD CONSTRAINT connector_enrolment_tokens_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: connector_enrolment_tokens connector_enrolment_tokens_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_enrolment_tokens
    ADD CONSTRAINT connector_enrolment_tokens_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: connectors connectors_enrolment_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_enrolment_token_id_fkey FOREIGN KEY (enrolment_token_id) REFERENCES public.connector_enrolment_tokens(id) ON DELETE SET NULL;


--
-- Name: connectors connectors_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: connectors connectors_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: connectors connectors_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: control_leases control_leases_browser_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_leases
    ADD CONSTRAINT control_leases_browser_session_id_fkey FOREIGN KEY (browser_session_id) REFERENCES public.browser_sessions(id) ON DELETE CASCADE;


--
-- Name: environments environments_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: environments environments_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: findings findings_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: findings findings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: findings findings_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.reviews(id) ON DELETE CASCADE;


--
-- Name: findings findings_screenshot_artefact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_screenshot_artefact_id_fkey FOREIGN KEY (screenshot_artefact_id) REFERENCES public.artefacts(id) ON DELETE RESTRICT;


--
-- Name: idempotency_keys idempotency_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: reviews reviews_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: reviews reviews_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: reviews reviews_source_browser_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_source_browser_session_id_fkey FOREIGN KEY (source_browser_session_id) REFERENCES public.browser_sessions(id) ON DELETE SET NULL;


--
-- Name: route_capabilities route_capabilities_published_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_capabilities
    ADD CONSTRAINT route_capabilities_published_service_id_fkey FOREIGN KEY (published_service_id) REFERENCES public.published_services(id) ON DELETE CASCADE;


--
-- Name: verification_artefacts verification_artefacts_artefact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_artefacts
    ADD CONSTRAINT verification_artefacts_artefact_id_fkey FOREIGN KEY (artefact_id) REFERENCES public.artefacts(id) ON DELETE RESTRICT;


--
-- Name: verification_artefacts verification_artefacts_verification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_artefacts
    ADD CONSTRAINT verification_artefacts_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.verifications(id) ON DELETE CASCADE;


--
-- Name: verifications verifications_finding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES public.findings(id) ON DELETE CASCADE;


--
-- Name: verifications verifications_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: verifications verifications_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;


--
-- Name: verifications verifications_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.reviews(id) ON DELETE CASCADE;


--
-- Name: viewer_sessions viewer_sessions_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_sessions
    ADD CONSTRAINT viewer_sessions_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict y8vTEmGG4lEkvwUBEe1c8a5l7GTjZT4V0YK34JdvXyqMZc7MnX2rWlGupaRg8zx

