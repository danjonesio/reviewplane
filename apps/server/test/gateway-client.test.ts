/**
 * Contract layer (`docs/TESTING.md` section 2): the gateway control API.
 *
 * The Go handler and this client are held together by
 * `services/tunnel-gateway/testdata/gateway-api/`, a committed corpus both run.
 * It is the same mechanism `packages/protocol` uses for the connector protocol,
 * applied to an interface the generator cannot yet render.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "../src/errors.ts";
import { HttpTunnelGateway } from "../src/modules/published-services/gateway-client.ts";
import type { GatewayRegisterRequest } from "../src/modules/published-services/gateway-client.ts";

interface Corpus {
  readonly endpoints: Readonly<Record<string, string>>;
  readonly authentication: { readonly scheme: string };
  readonly register_request_fields: readonly string[];
  readonly route_view_fields: readonly string[];
  readonly examples: {
    readonly register_request: GatewayRegisterRequest;
    readonly register_response: { readonly data: Record<string, unknown> };
    readonly register_rejection: { readonly error: { readonly code: string } };
  };
}

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "services",
  "tunnel-gateway",
  "testdata",
  "gateway-api",
  "register.json",
);

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;

const TOKEN = "control-plane-token-0123456789abcdef";

function client(handler: (request: Request) => Promise<Response> | Response): HttpTunnelGateway {
  return new HttpTunnelGateway({
    baseUrl: "http://tunnel-gateway.test",
    token: TOKEN,
    fetch: (input, init) => Promise.resolve(handler(new Request(input as string, init))),
  });
}

test("the client sends exactly the fields the corpus records", async () => {
  let seen: Record<string, unknown> = {};
  let seenUrl = "";
  let seenAuthorisation: string | null = null;
  const gateway = client(async (request) => {
    seenUrl = request.url;
    seenAuthorisation = request.headers.get("authorization");
    seen = (await request.json()) as Record<string, unknown>;
    return Response.json(corpus.examples.register_response);
  });

  await gateway.register(corpus.examples.register_request);

  assert.deepEqual(
    Object.keys(seen).sort(),
    [...corpus.register_request_fields].sort(),
    "the client and the corpus disagree about the register request",
  );
  assert.equal(
    seenUrl,
    `http://tunnel-gateway.test/internal/v1/routes/${corpus.examples.register_request.route_id}`,
  );
  assert.equal(seenAuthorisation, `Bearer ${TOKEN}`);
});

test("the corpus response carries every field the client reads", () => {
  assert.deepEqual(
    Object.keys(corpus.examples.register_response.data).sort(),
    [...corpus.route_view_fields].sort(),
  );
});

test("a gateway refusal keeps its stable class", async () => {
  // One failure must have one code all the way to the caller: the class the
  // gateway chose is the class the API answers with.
  const gateway = client(() =>
    Response.json(corpus.examples.register_rejection, { status: 422 }),
  );
  await assert.rejects(
    gateway.register(corpus.examples.register_request),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, corpus.examples.register_rejection.error.code);
      assert.equal(error.code, "DESTINATION_NOT_ALLOWED");
      return true;
    },
  );
});

test("an unreachable gateway is CONNECTOR_OFFLINE, not an internal error", async () => {
  const gateway = client(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(gateway.register(corpus.examples.register_request), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "CONNECTOR_OFFLINE");
    assert.equal(error.status, 503);
    return true;
  });
});

test("revocation is idempotent against a gateway that has forgotten the route", async () => {
  const gateway = client(() => new Response(null, { status: 404 }));
  await gateway.revokeRoute("svc_already_gone");
  await gateway.revokeCapability("cap_already_gone");
});

test("a gateway failure on revocation is reported", async () => {
  const gateway = client(() => new Response(null, { status: 500 }));
  await assert.rejects(gateway.revokeRoute("svc_a"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    return true;
  });
});

test("the corpus names the endpoints the client uses", () => {
  assert.equal(corpus.endpoints["register"], "PUT /internal/v1/routes/{routeId}");
  assert.equal(corpus.endpoints["revoke_route"], "DELETE /internal/v1/routes/{routeId}");
  assert.equal(
    corpus.endpoints["revoke_capability"],
    "DELETE /internal/v1/capabilities/{capabilityId}",
  );
  assert.equal(corpus.authentication.scheme, "Bearer");
});
