/**
 * A stub control plane for the browser suite.
 *
 * It implements the `docs/API.md` section 15 artefact flow for real: the
 * intent records the declared size and digest, the content is stored, and the
 * artefact becomes available only when the *server side* recomputes the digest
 * of the stored bytes and finds it matches. That is the property the worker
 * has to be held to — that it claims no evidence the control plane has not
 * verified — and stubbing it any weaker would test nothing.
 *
 * `apps/server` implements the same flow against PostgreSQL; its own tests
 * cover the database and the events.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StoredArtefact {
  readonly id: string;
  readonly projectId: string;
  readonly declaredSha256: string;
  readonly declaredSize: number;
  state: "pending" | "uploaded" | "available" | "failed";
  bytes: Buffer | null;
  sha256: string | null;
}

export interface StubControlPlane {
  readonly origin: string;
  readonly artefacts: Map<string, StoredArtefact>;
  readonly statusReports: { sessionId: string; status: string; reason?: string }[];
  /** Set to make completion fail, for the fault-injection cases. */
  refuseCompletion: boolean;
  /** Set to make the content upload fail. */
  refuseUpload: boolean;
  stop(): Promise<void>;
}

export async function startStubControlPlane(credential: string): Promise<StubControlPlane> {
  const artefacts = new Map<string, StoredArtefact>();
  const statusReports: { sessionId: string; status: string; reason?: string }[] = [];
  const state = { refuseCompletion: false, refuseUpload: false };
  let counter = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://control-plane.invalid");
      const authorised = request.headers.authorization === `Bearer ${credential}`;
      const send = (status: number, body: unknown): void => {
        const encoded = JSON.stringify(body);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(encoded);
      };
      if (!authorised) {
        send(401, { error: { code: "AUTHENTICATION_REQUIRED", message: "credential required" } });
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      if (url.pathname.endsWith("/artefacts/uploads")) {
        const declared = JSON.parse(body.toString("utf8")) as {
          sha256: string;
          size_bytes: number;
        };
        counter += 1;
        const id = `art_stub${String(counter)}`;
        const projectId = url.pathname.split("/")[4] ?? "unknown";
        artefacts.set(id, {
          id,
          projectId,
          declaredSha256: declared.sha256,
          declaredSize: declared.size_bytes,
          state: "pending",
          bytes: null,
          sha256: null,
        });
        send(201, {
          data: { artefact_id: id, state: "pending", upload_path: `/api/v1/artefacts/${id}/content` },
        });
        return;
      }

      const contentMatch = /^\/api\/v1\/artefacts\/([^/]+)\/content$/u.exec(url.pathname);
      if (contentMatch !== null) {
        if (state.refuseUpload) {
          send(503, { error: { code: "INTERNAL_ERROR", message: "artefact store unavailable" } });
          return;
        }
        const artefact = artefacts.get(contentMatch[1] as string);
        if (artefact === undefined) {
          send(404, { error: { code: "RESOURCE_NOT_FOUND", message: "no such artefact" } });
          return;
        }
        artefact.bytes = body;
        artefact.state = "uploaded";
        send(202, { data: { artefact_id: artefact.id, state: artefact.state } });
        return;
      }

      const completeMatch = /^\/api\/v1\/artefacts\/([^/]+)\/complete$/u.exec(url.pathname);
      if (completeMatch !== null) {
        const artefact = artefacts.get(completeMatch[1] as string);
        if (artefact === undefined) {
          send(404, { error: { code: "RESOURCE_NOT_FOUND", message: "no such artefact" } });
          return;
        }
        if (state.refuseCompletion || artefact.bytes === null) {
          artefact.state = "failed";
          send(409, {
            error: { code: "ARTEFACT_UPLOAD_INCOMPLETE", message: "verification did not succeed" },
          });
          return;
        }
        const observed = JSON.parse(body.toString("utf8")) as { sha256: string };
        const actual = createHash("sha256").update(artefact.bytes).digest("hex");
        if (actual !== artefact.declaredSha256 || actual !== observed.sha256) {
          artefact.state = "failed";
          send(409, {
            error: { code: "ARTEFACT_UPLOAD_INCOMPLETE", message: "digest mismatch" },
          });
          return;
        }
        artefact.state = "available";
        artefact.sha256 = actual;
        send(200, {
          data: {
            id: artefact.id,
            state: "available",
            sha256: actual,
            size_bytes: artefact.bytes.byteLength,
            content_type: "image/png",
          },
        });
        return;
      }

      if (url.pathname === "/internal/v1/workers/register") {
        send(200, {
          worker_id: "wkr_stub",
          payload: {
            accepted: true,
            assigned_projects: ["prj_fixture"],
            session_limits: {
              max_duration_seconds: 7200,
              default_timeout_ms: 30000,
              max_command_timeout_ms: 120000,
              screenshot_max_bytes: 20971520,
              snapshot_max_nodes: 400,
              snapshot_max_bytes: 32768,
            },
            heartbeat_interval_seconds: 15,
          },
        });
        return;
      }

      const statusMatch = /^\/internal\/v1\/browser-sessions\/([^/]+)\/status$/u.exec(url.pathname);
      if (statusMatch !== null) {
        const frame = JSON.parse(body.toString("utf8")) as {
          payload: { status: string; reason?: string };
        };
        statusReports.push({
          sessionId: statusMatch[1] as string,
          status: frame.payload.status,
          ...(frame.payload.reason === undefined ? {} : { reason: frame.payload.reason }),
        });
        response.writeHead(204);
        response.end();
        return;
      }

      send(404, { error: { code: "RESOURCE_NOT_FOUND", message: "no such route" } });
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    artefacts,
    statusReports,
    get refuseCompletion() {
      return state.refuseCompletion;
    },
    set refuseCompletion(value: boolean) {
      state.refuseCompletion = value;
    },
    get refuseUpload() {
      return state.refuseUpload;
    },
    set refuseUpload(value: boolean) {
      state.refuseUpload = value;
    },
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
