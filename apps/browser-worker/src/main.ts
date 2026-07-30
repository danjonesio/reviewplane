/** Entry point. Configuration is validated before anything is started. */

import { ConfigurationError, loadWorkerConfig } from "./config.ts";
import { createLogger } from "./logging.ts";
import { startWorker } from "./worker.ts";

const logger = createLogger({ service: "browser-worker" });

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const worker = await startWorker({ config, logger });

  const stop = (signal: string): void => {
    logger.info("shutting down", { signal });
    void worker.stop().then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.on("SIGINT", () => {
    stop("SIGINT");
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    logger.error("configuration is invalid", { detail: error.message });
    process.exit(78);
  }
  logger.error("the browser worker could not start", {
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
