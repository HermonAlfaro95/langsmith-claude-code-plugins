import { dirname, join } from "node:path";
import { launchDetachedWorker, openPluginSession } from "@langchain/plugins-base/plugin";
import { createLangSmithUploadWriter } from "@langchain/plugins-base/tracing/upload";
import { loadConfig } from "./config.js";
import {
  ENGINE_STORAGE_DIR_NAME,
  ENGINE_WORKER_ARG,
  LS_INTEGRATION,
  RECOVERY_REPORT_PROBLEM_STATUSES,
} from "./constants.js";
import { writerOptions } from "./engine-writer.js";
import { settleToolRuns } from "./engine-tool-settlement.js";
import { WORKER_LOG_FILE, warn } from "./logger.js";
import type { ClaudeTracingSession, Config } from "./types.js";

export function openSession(
  config: Config,
  cwd: string,
  sessionId: string,
  startupWaitMs?: number,
): ClaudeTracingSession {
  const writer = writerOptions(config);
  const context = openPluginSession({
    storageRoot: join(dirname(config.stateFilePath), ENGINE_STORAGE_DIR_NAME),
    integration: LS_INTEGRATION,
    sessionId,
    writer,
    currentWriter: () => writerOptions(loadConfig({ cwd, deferGit: true })),
    scheduleWake: (id) =>
      launchDetachedWorker([ENGINE_WORKER_ARG, cwd, id], { logFile: WORKER_LOG_FILE }),
    reconstruct: settleToolRuns,
    startupWaitMs,
    onRecoveryReport: (report) => {
      if (RECOVERY_REPORT_PROBLEM_STATUSES.includes(report.status)) {
        warn(`Could not upload every older session: ${JSON.stringify(report)}`);
      }
    },
  });
  return { ...context, destinations: createLangSmithUploadWriter(writer).destinations };
}
