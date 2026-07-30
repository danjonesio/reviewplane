/**
 * Entry point. Starts the fixture and nothing else; the composition lives in
 * `app.ts` so that tests exercise the same code path without a subprocess.
 */

import { startStaticApp } from "./app.ts";

const app = await startStaticApp().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return process.exit(1);
});

process.stdout.write(
  `${JSON.stringify({
    level: "info",
    service: "static-app",
    event: "listening",
    origin: app.origin,
  })}\n`,
);

// Stopped explicitly on a signal, so a pending `/slow` response is dropped
// rather than holding the process open past the operator's interrupt.
const shutdown = (): void => {
  void app.stop().then(() => {
    process.exit(0);
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
