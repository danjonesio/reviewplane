#!/usr/bin/env bash
#
# Generates the secrets and TLS material the Compose stack needs.
#
# Everything it writes is development material for a stack that publishes no
# port and reaches no network. None of it is committed: `deploy/compose/secrets`
# and `deploy/compose/tls` are ignored except for their `.gitkeep`.
#
# The files are written 0644 rather than 0600, which needs justifying.
# `uid`, `gid` and `mode` on a Compose secret reference are honoured by Docker
# Swarm only; plain Compose bind-mounts the file with the permissions it has on
# the host, and every container here runs as uid 10001 rather than as the user
# running this script. A production deployment SHOULD deliver these through
# Swarm or Kubernetes secrets, or pre-create them owned by the service user;
# `deploy/compose/README.md` records that. Loosening the mode is acceptable for
# generated development credentials to a stack with no published port, and is
# not acceptable for anything else.
#
# It is idempotent. Existing material is left alone, because regenerating the
# capability signing key while the stack is running would invalidate every
# capability the control plane has already minted, and regenerating the gateway
# certificate would invalidate the pin the worker was started with (ADR-0015).
# Pass --force to replace everything.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="${COMPOSE_DIR}/secrets"
TLS="${COMPOSE_DIR}/tls"
# The tunnel CA's private key lives outside ${TLS}, which is bind-mounted into
# the gateway and the development fixture. Nothing in either container needs it
# — a CA key signs certificates, and signing happens here — so it has no
# business being reachable from inside one. Its mode already denies both service
# users, but "unreadable material inside a mount" is a weaker property than
# "material that is not in the mount", and only the second survives someone
# later loosening a mode or adding a container that runs as root.
CA="${COMPOSE_DIR}/ca"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p "${SECRETS}" "${TLS}" "${CA}"
chmod 700 "${CA}"

# A secret file the stack mounts. Its mode is justified in the header; the value
# is never echoed.
write_secret() {
  local name="$1" value="$2" path="${SECRETS}/$1"
  if [[ -s "${path}" && "${FORCE}" -eq 0 ]]; then
    return
  fi
  printf '%s' "${value}" > "${path}"
  chmod 644 "${path}"
  echo "wrote secrets/${name}"
}

random_token() {
  # 48 bytes base64url: comfortably past the 32-character minimum the control
  # plane enforces on every administrative and inter-service credential.
  openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_'
}

CAPABILITY_KEY_ID="stage0-a"

write_secret postgres_password "$(random_token)"
write_secret bootstrap_token "$(random_token)"
write_secret worker_credential "$(random_token)"
write_secret worker_command_credential "$(random_token)"
write_secret tunnel_control_token "$(random_token)"

# The database URL has to agree with the password that was just written, which
# may be one this script generated on an earlier run.
POSTGRES_PASSWORD="$(cat "${SECRETS}/postgres_password")"
if [[ ! -s "${SECRETS}/database_url" || "${FORCE}" -eq 1 ]]; then
  printf 'postgres://reviewplane:%s@postgres:5432/reviewplane' "${POSTGRES_PASSWORD}" \
    > "${SECRETS}/database_url"
  chmod 644 "${SECRETS}/database_url"
  echo "wrote secrets/database_url"
fi

# One capability signing key, in the two forms its two readers want: the control
# plane signs with the raw key, the gateway selects from a keyring by key id.
# Deriving both from one value is what stops them drifting apart.
if [[ ! -s "${SECRETS}/capability_signing_key" || "${FORCE}" -eq 1 ]]; then
  CAPABILITY_KEY="$(openssl rand -base64 32)"
  printf '%s' "${CAPABILITY_KEY}" > "${SECRETS}/capability_signing_key"
  printf '%s:%s' "${CAPABILITY_KEY_ID}" "${CAPABILITY_KEY}" > "${SECRETS}/capability_keys"
  chmod 644 "${SECRETS}/capability_signing_key" "${SECRETS}/capability_keys"
  echo "wrote secrets/capability_signing_key and secrets/capability_keys"
fi

# The enrolment token is issued by the running control plane, not here. The file
# has to exist for Compose to mount it, so it is created empty and filled in by
# run.sh once the server is up.
if [[ ! -f "${SECRETS}/enrolment_token" ]]; then
  : > "${SECRETS}/enrolment_token"
  chmod 644 "${SECRETS}/enrolment_token"
fi

# The connector configuration the fixture container mounts. It is a copy of the
# committed template, because the project identifier in it is minted by the
# control plane at run time and run.sh rewrites this copy rather than the
# template.
if [[ ! -s "${COMPOSE_DIR}/connector-config.generated.yaml" || "${FORCE}" -eq 1 ]]; then
  cp "${COMPOSE_DIR}/connector-config.yaml" "${COMPOSE_DIR}/connector-config.generated.yaml"
  chmod 644 "${COMPOSE_DIR}/connector-config.generated.yaml"
  echo "wrote connector-config.generated.yaml"
fi

# The tunnel CA and the gateway's serving certificate for *.internal.invalid.
#
# No public authority can issue for a reserved TLD, so the deployment runs its
# own. It is a real two-level chain rather than a self-signed leaf because a
# trust anchor has to be a CA: Go refuses a self-signed leaf presented as a root
# with "certificate signed by unknown authority", which is what the connector's
# data channel would hit. The browser worker does not use this chain at all — it
# pins the leaf's public key (ADR-0015) — but the connector does.
if [[ ! -s "${TLS}/gateway.crt" || "${FORCE}" -eq 1 ]]; then
  # The authority.
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "${CA}/tunnel-ca.key" -out "${TLS}/tunnel-ca.pem" \
    -days 365 -nodes -subj "/CN=ReviewPlane Tunnel CA/O=ReviewPlane" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    2> /dev/null

  # The gateway's leaf. The SAN covers the wildcard the browser resolves and the
  # service name the control plane and the connector dial.
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "${TLS}/gateway.key" -out "${TLS}/gateway.csr" \
    -nodes -subj "/CN=tunnel-gateway/O=ReviewPlane" 2> /dev/null

  cat > "${TLS}/gateway.ext" <<'EXT'
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:*.internal.invalid,DNS:internal.invalid,DNS:tunnel-gateway,DNS:localhost,IP:127.0.0.1
EXT

  openssl x509 -req -in "${TLS}/gateway.csr" \
    -CA "${TLS}/tunnel-ca.pem" -CAkey "${CA}/tunnel-ca.key" -CAcreateserial \
    -out "${TLS}/gateway.crt" -days 365 -sha256 \
    -extfile "${TLS}/gateway.ext" 2> /dev/null

  rm -f "${TLS}/gateway.csr" "${TLS}/gateway.ext" "${TLS}/tunnel-ca.srl" "${CA}/tunnel-ca.srl"

  # The gateway runs as uid 10001 and mounts this directory read-only, so the
  # material is readable rather than 0600 for the reason recorded in the header.
  chmod 644 "${TLS}/gateway.crt" "${TLS}/gateway.key" "${TLS}/tunnel-ca.pem"
  chmod 600 "${CA}/tunnel-ca.key"
  echo "wrote ca/tunnel-ca.key (never mounted), tls/tunnel-ca.pem, tls/gateway.crt and tls/gateway.key"
fi

# The pin the browser worker is started with. It is a digest of a public key, so
# it is deployment data rather than a secret, and it is printed rather than
# hidden: an operator has to be able to check that the value in their
# environment matches the certificate the gateway is serving.
SPKI="$(openssl x509 -in "${TLS}/gateway.crt" -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl base64)"
printf 'REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI=%s\n' "${SPKI}" > "${COMPOSE_DIR}/.env"
echo "wrote .env with REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI=${SPKI}"
