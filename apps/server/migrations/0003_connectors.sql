-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Development environments, connectors, enrolment tokens and the Stage 0
-- connector certificate authority.
--
-- docs/DOMAIN_MODEL.md section 7 defines the environment and section 8 the
-- connector and its lifecycle; docs/CONNECTOR_PROTOCOL.md section 4.1 defines
-- the enrolment token; ADR-0014 records the certificate authority.

create table if not exists environments (
  id               text        primary key,
  organisation_id  text        not null references organisations (id) on delete cascade,
  project_id       text        references projects (id) on delete set null,
  name             text        not null,
  platform         text        not null,
  architecture     text        not null,
  labels           text[]      not null default '{}',
  -- docs/DOMAIN_MODEL.md section 7. Stage 0 records the value; policy that
  -- reads it arrives with the permission model.
  trust_level      text        not null default 'standard',
  status           text        not null default 'ACTIVE',
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists environments_organisation_index on environments (organisation_id);

-- One-time enrolment tokens (docs/CONNECTOR_PROTOCOL.md section 4.1,
-- docs/API.md section 9). Only the hash is stored: the token is shown once, at
-- issuance, and the control plane never needs the value again.
create table if not exists connector_enrolment_tokens (
  id                  text        primary key,
  organisation_id     text        not null references organisations (id) on delete cascade,
  project_id          text        references projects (id) on delete cascade,
  token_hash          text        not null unique,
  environment_labels  text[]      not null default '{}',
  max_uses            integer     not null default 1,
  uses                integer     not null default 0,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  created_by          text        not null,
  consumed_at         timestamptz,
  revoked_at          timestamptz,

  constraint connector_enrolment_tokens_max_uses_positive check (max_uses >= 1),
  constraint connector_enrolment_tokens_uses_bounded check (uses >= 0 and uses <= max_uses)
);

create index if not exists connector_enrolment_tokens_organisation_index
  on connector_enrolment_tokens (organisation_id);

-- Connector installations and their cryptographic identities
-- (docs/DOMAIN_MODEL.md section 8).
create table if not exists connectors (
  id                       text        primary key,
  organisation_id          text        not null references organisations (id) on delete cascade,
  environment_id           text        not null references environments (id) on delete cascade,
  project_id               text        references projects (id) on delete set null,
  enrolment_token_id       text        references connector_enrolment_tokens (id) on delete set null,
  certificate_fingerprint  text        not null unique,
  certificate_serial       text        not null,
  certificate_not_after    timestamptz not null,
  public_key               text        not null,
  version                  text        not null,
  capabilities             text[]      not null default '{}',
  -- docs/DOMAIN_MODEL.md section 8 lifecycle:
  -- PENDING_ENROLMENT -> ACTIVE -> DEGRADED -> DISCONNECTED -> REVOKED.
  status                   text        not null default 'PENDING_ENROLMENT',
  connected_at             timestamptz,
  last_heartbeat_at        timestamptz,
  revoked_at               timestamptz,
  created_at               timestamptz not null default now(),

  constraint connectors_status_known check (
    status in ('PENDING_ENROLMENT', 'ACTIVE', 'DEGRADED', 'DISCONNECTED', 'REVOKED')
  )
);

create index if not exists connectors_organisation_index on connectors (organisation_id);
create index if not exists connectors_status_heartbeat_index on connectors (status, last_heartbeat_at);

-- Stage 0 connector certificate authority and the connector listener's own
-- certificate (ADR-0014). The CA private key never leaves the server: it is
-- returned by no API and appears in no log.
create table if not exists connector_tls_material (
  purpose         text        primary key,
  certificate_pem text        not null,
  private_key_pem text        not null,
  not_after       timestamptz not null,
  created_at      timestamptz not null default now(),

  constraint connector_tls_material_purpose_known check (purpose in ('certificate_authority', 'listener'))
);
