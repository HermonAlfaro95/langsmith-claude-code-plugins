import { metadataForMode, projectCodingAgentMetadata } from "@langchain/plugins-base/metadata";
import { createCodingAgentRunTree, MUTED_TRACE_CONTENT } from "@langchain/plugins-base/privacy";
import type { RunTree, RunTreeConfig } from "langsmith";
import { LS_INTEGRATION, METADATA_MODE_RUN_FIELDS } from "./constants.js";
import type { TracingMode } from "./types.js";

export { MUTED_TRACE_CONTENT };

export function createRunTree(config: RunTreeConfig, mode: TracingMode = "full"): RunTree {
  return createCodingAgentRunTree(config, LS_INTEGRATION, mode);
}

function projectReplica(replica: unknown): unknown {
  if (!replica || typeof replica !== "object") return replica;
  // The SDK also accepts [projectName, updates] tuples.
  if (Array.isArray(replica)) return { projectName: replica[0] };
  const { updates: _updates, ...safe } = replica as Record<string, unknown>;
  return safe;
}

export function runConfigForMode<T extends Record<string, unknown>>(
  config: T,
  mode: TracingMode = "full",
): T {
  if (mode === "full") return config;
  const status = config.error ? "error" : config.end_time != null ? "completed" : "running";
  const extra = config.extra as { metadata?: Record<string, unknown> } | undefined;
  const safe: Record<string, unknown> = {};
  for (const key of METADATA_MODE_RUN_FIELDS) {
    if (key in config && config[key] !== undefined) safe[key] = config[key];
  }
  if (Array.isArray(config.replicas)) safe.replicas = config.replicas.map(projectReplica);
  safe.inputs = { messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] };
  safe.outputs = { messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }] };
  safe.extra = {
    metadata: metadataForMode(extra?.metadata, LS_INTEGRATION, mode, status),
    toJSON(this: { metadata?: Record<string, unknown> }) {
      return { metadata: projectCodingAgentMetadata(this.metadata, LS_INTEGRATION, status) };
    },
  };
  return safe as T;
}
