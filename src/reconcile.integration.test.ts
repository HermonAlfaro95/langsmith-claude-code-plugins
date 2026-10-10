import { chmodSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import type { ReconstructionJob } from "@langchain/plugins-base/tracing/reconstruction";

import {
  alpha,
  appendReply,
  beta,
  createdMetadataAll,
  createdMetadataOf,
  hookLog,
  hook,
  metadataOf,
  notification,
  plain,
  prompt,
  recordDir,
  recordFiles,
  recordLines,
  sandbox,
  service,
  stop,
  subagent,
  task,
  tool,
  reply,
  useReconcileSandbox,
  waitFor,
} from "./fixtures/reconcile-sandbox.js";
import {
  recordDelivered,
  recordRun,
  recordToolOrigin,
  readTurnRecord,
  turnRecordPath,
} from "./turn-record.js";
import { queueOrigin } from "./queue.js";
import { getSessionState, loadState } from "./state.js";
import {
  acknowledgeClaudeSharedDeliveries,
  reconstructClaudeRun,
  turnAttributionWithToolOrigins,
} from "./tracing-engine.js";
import {
  CLAUDE_CODE_INTEGRATION,
  CLAUDE_RUN_RECONSTRUCTION_EVENT_SUFFIX,
  CLAUDE_RUN_SNAPSHOT_EVENT_SUFFIX,
  CLAUDE_RUN_SNAPSHOT_SOURCE_SEPARATOR,
  SHARED_ENGINE_STORAGE_DIRECTORY,
} from "./constants.js";

const session = (id: string, cwd: string) => ({
  session_id: id,
  transcript_path: join(plain, `${id}.jsonl`),
  cwd,
});

describe("settling a turn's repository and author", { timeout: 120_000 }, () => {
  useReconcileSandbox();

  // Catches a tool call that waits on the upload before the hook returns, which is the
  // whole cost this change removes. No other test holds the service open mid-turn.
  it("finishes a tool call before a deliberately slow upload has answered", async () => {
    const base = session("slow-upload", alpha);
    await prompt(base);

    service.delayMs = 2000;
    const startedAt = Date.now();
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    const hookTook = Date.now() - startedAt;

    expect(hookTook).toBeLessThan(service.delayMs);
    service.delayMs = 0;
    expect(await waitFor(() => metadataOf("Read").repository_name === "acme/a")).toBe(true);
  });

  // Catches every call being left running until the turn ends, which shows a finished tool
  // as still working and leaves it that way for good if the turn never closes.
  it("finishes a call that already knows where it worked", async () => {
    const base = session("already-known", alpha);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    await tool(base, "Glob", { path: join(plain, "notes.txt") });

    expect(
      await waitFor(() => service.created.filter((run) => run.run_type === "tool").length === 2),
    ).toBe(true);
    const created = (name: string) => service.created.find((run) => run.name === name);
    expect(created("Read")?.end_time).toBeTruthy();
    expect(created("Glob")?.end_time).toBeTruthy();
  });

  // Catches a reconcile that never runs for a turn that already knew its repository, so a
  // call reaching outside the checkout is the one run in the trace with no repository at all.
  it("gives the turn's own repository to a call that landed outside every repository", async () => {
    const base = session("root-known", alpha);
    await prompt(base);
    await tool(base, "Read", { file_path: join(plain, "notes.txt") });
    reply(base);
    await stop(base);

    expect(await waitFor(() => metadataOf("Read").repository_name === "acme/a")).toBe(true);
    expect(metadataOf("Read")).toMatchObject({
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    });
    // The turn's own run was finished by its close, so the service refusing the repeat is
    // the turn being settled rather than something to retry forever.
    expect(await waitFor(() => recordFiles("root-known").length === 0)).toBe(true);
  });

  // Catches a model run closed the moment the turn is traced, which is the one run under a
  // turn that can never be told who was working once the turn has settled.
  it("uploads a model run already knowing the repository and the author", async () => {
    const base = session("model-born-known", alpha);
    await prompt(base);
    reply(base);
    await stop(base);

    expect(
      await waitFor(() => Object.keys(createdMetadataOf(base.session_id, "Claude")).length > 0),
    ).toBe(true);
    expect(createdMetadataOf(base.session_id, "Claude")).toMatchObject({
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    });
  });

  // Catches a model run uploaded before the turn's own tool calls are consulted, which
  // leaves it the only run in the trace with no repository at all.
  it("uploads a model run knowing the repository a call reached into", async () => {
    const base = session("model-born-outside", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
    ]);
    await stop(base);

    expect(
      await waitFor(() => Object.keys(createdMetadataOf(base.session_id, "Claude")).length > 0),
    ).toBe(true);
    expect(createdMetadataOf(base.session_id, "Claude")).toMatchObject({
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    });
  });

  it("saves a standalone current turn before reconstructing its model run", async () => {
    const base = session("standalone-model-origin", plain);
    reply(base, 1, [
      {
        id: "use-beta-read",
        name: "Read",
        input: { file_path: join(beta, "seed.txt") },
      },
    ]);
    await stop(base);

    expect(await waitFor(() => createdMetadataAll(base.session_id, "Claude").length > 0)).toBe(
      true,
    );
    expect(createdMetadataOf(base.session_id, "Claude")).toMatchObject({
      repository_name: "acme/b",
      git_branch: "trunk-b",
      ls_attribution_identifier: "Beta Owner",
    });
    const nativeRecord = readTurnRecord(
      join(recordDir(base.session_id), recordFiles(base.session_id)[0]),
    );
    expect(nativeRecord?.root?.routing).toEqual({ cwd: base.cwd });
  });

  it("includes captured tool attribution in initial model and Agent posts while the worker is held", async () => {
    const base = session("held-tool-upload", plain);
    const held = service.holdNextUploadNamed("Read");
    try {
      await prompt(base);
      await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
      await held.entered;
      await subagent(base, "held-agent");
      await task(base, "held-agent");
      reply(base, 1, [
        {
          id: "use-Read",
          name: "Read",
          input: { file_path: join(alpha, "seed.txt") },
        },
        {
          id: "use-held-agent",
          name: "Task",
          input: { prompt: "go and look" },
          agentId: "held-agent",
        },
      ]);
      await stop(base);

      expect(service.created.some((run) => run.name === "Claude" || run.name === "Agent")).toBe(
        false,
      );
    } finally {
      held.release();
    }

    const attributed = {
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    };
    expect(await waitFor(() => createdMetadataAll(base.session_id, "Claude").length > 0)).toBe(
      true,
    );
    expect(await waitFor(() => service.created.some((run) => run.name === "Agent"))).toBe(true);
    expect({
      models: createdMetadataAll(base.session_id, "Claude"),
      agent: createdMetadataOf(base.session_id, "Agent"),
    }).toEqual({
      models: expect.arrayContaining([expect.objectContaining(attributed)]),
      agent: expect.objectContaining(attributed),
    });
  });

  it("fails Stop when a completed tool origin cannot be saved", async () => {
    const base = session("origin-save-fails", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
    ]);

    const [recordName] = recordFiles(base.session_id);
    expect(recordName).toBeDefined();
    const path = join(recordDir(base.session_id), recordName!);
    const permissions = statSync(path).mode & 0o777;
    chmodSync(path, permissions & ~0o222);
    try {
      await stop(base);
      expect(hookLog()).toContain("Could not save tool use-Read's repository origin before Stop");
      expect(service.created.some((run) => run.name === "Claude" || run.name === "Agent")).toBe(
        false,
      );
    } finally {
      chmodSync(path, permissions);
    }
  });

  it("retries a model reconstruction after its run record cannot be saved", async () => {
    const base = session("run-record-save-fails", alpha);
    await prompt(base);
    reply(base);

    const stateFile = join(sandbox.root, "state.json");
    const before = getSessionState(loadState(stateFile), base.session_id);
    const rootRunId = before.current_turn_run_id;
    expect(rootRunId).toBeDefined();
    const [recordName] = recordFiles(base.session_id);
    expect(recordName).toBeDefined();
    const path = join(recordDir(base.session_id), recordName!);
    const permissions = statSync(path).mode & 0o777;

    chmodSync(path, permissions & ~0o222);
    try {
      await stop(base);
      expect(hookLog()).toContain("Could not add to the turn record");
      expect(hookLog()).toContain("Could not capture shared Claude LLM run");
      expect(service.created.some((run) => run.name === "Claude")).toBe(false);
      const failed = getSessionState(loadState(stateFile), base.session_id);
      expect(failed.current_turn_run_id).toBe(rootRunId);
      expect(failed.last_line).toBe(before.last_line);
      expect(service.updated.some((run) => run.id === rootRunId)).toBe(false);
    } finally {
      chmodSync(path, permissions);
    }

    await stop(base);

    expect(await waitFor(() => createdMetadataAll(base.session_id, "Claude").length === 1)).toBe(
      true,
    );
    expect(service.created.filter((run) => run.name === "Claude Code Turn")).toEqual([
      expect.objectContaining({ id: rootRunId }),
    ]);
    expect(
      await waitFor(() => service.updated.some((run) => run.id === rootRunId && run.end_time)),
    ).toBe(true);
    expect(
      getSessionState(loadState(stateFile), base.session_id).current_turn_run_id,
    ).toBeUndefined();
  });

  it("does not upload a full model run when its active root record is missing", async () => {
    const base = session("missing-active-root-record", alpha);
    await prompt(base);
    reply(base);

    const stateFile = join(sandbox.root, "state.json");
    const before = getSessionState(loadState(stateFile), base.session_id);
    const rootRunId = before.current_turn_run_id;
    expect(rootRunId).toBeDefined();
    const [recordName] = recordFiles(base.session_id);
    expect(recordName).toBeDefined();
    const path = join(recordDir(base.session_id), recordName!);
    const savedPath = `${path}.saved`;
    renameSync(path, savedPath);
    try {
      await stop(base);
      expect(service.created.some((run) => run.name === "Claude")).toBe(false);
      expect(getSessionState(loadState(stateFile), base.session_id).current_turn_run_id).toBe(
        rootRunId,
      );
    } finally {
      renameSync(savedPath, path);
    }

    await stop(base);
    expect(await waitFor(() => createdMetadataAll(base.session_id, "Claude").length > 0)).toBe(
      true,
    );
  });

  it("drops a held model reconstruction if its native turn record disappears", async () => {
    const base = session("deleted-native-turn-record", plain);
    const held = service.holdNextUploadNamed("Read");
    const stateFile = join(sandbox.root, "state.json");
    const reconstructionStore = createCaptureStore(
      join(sandbox.root, SHARED_ENGINE_STORAGE_DIRECTORY, "reconstruction-v1"),
    );
    let path: string | undefined;
    let savedPath: string | undefined;
    try {
      await prompt(base);
      await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
      await held.entered;
      reply(base);
      const rootRunId = getSessionState(loadState(stateFile), base.session_id).current_turn_run_id;
      expect(rootRunId).toBeDefined();
      await stop(base);

      const job = (
        await reconstructionStore.enumerate(CLAUDE_CODE_INTEGRATION, base.session_id)
      ).find(({ record }) => record.eventId.endsWith(CLAUDE_RUN_RECONSTRUCTION_EVENT_SUFFIX));
      expect(job).toBeDefined();
      path = turnRecordPath(stateFile, base.session_id, rootRunId!);
      savedPath = `${path}.saved`;
      expect(existsSync(path)).toBe(true);
      renameSync(path, savedPath);
      held.release();

      const deadline = Date.now() + 20_000;
      let outcome: Awaited<ReturnType<typeof reconstructionStore.readOutcome>> | undefined;
      while (Date.now() < deadline) {
        outcome = await reconstructionStore.readOutcome(
          job!.record,
          job!.record.destinationFingerprint,
        );
        if (outcome.status === "settled") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(outcome).toMatchObject({ status: "settled", receipt: { outcome: "dropped" } });
      expect(service.created.some((run) => run.name === "Claude")).toBe(false);
    } finally {
      held.release();
      if (path && savedPath && existsSync(savedPath)) renameSync(savedPath, path);
    }
  });

  it("keeps a turn running when a completed tool has no Git result", async () => {
    const base = session("origin-has-no-git-result", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(plain, "notes.txt") });
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(plain, "notes.txt") } },
    ]);
    await stop(base);

    expect(await waitFor(() => createdMetadataAll(base.session_id, "Claude").length > 0)).toBe(
      true,
    );
    expect(
      createdMetadataAll(base.session_id, "Claude").every(
        (metadata) => !Object.hasOwn(metadata, "repository_name"),
      ),
    ).toBe(true);
  });

  it("reuses a resolved tool origin for later model and Agent reconstructions", () => {
    const path = turnRecordPath(join(sandbox.root, "state.json"), "origin-cache", "root");
    const origin = "account";
    recordRun({
      path,
      run: {
        id: "root",
        name: "turn",
        run_type: "chain",
        trace_id: "root",
        dotted_order: "root",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
    });
    recordRun({
      path,
      run: {
        id: "read-run",
        name: "Read",
        run_type: "tool",
        trace_id: "root",
        parent_run_id: "root",
        dotted_order: "root.read",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      toolUseId: "use-read",
    });
    recordToolOrigin(path, origin, "full", {
      toolUseId: "use-read",
      toolName: "Read",
      order: 0,
      origin: { path: join(alpha, "seed.txt"), cwd: plain, namedAPath: true },
    });

    let resolutions = 0;
    const resolve = () => {
      resolutions++;
      return {
        repository_name: "acme/a",
        repository_provider: "github",
        repository_url: "https://github.com/acme/a",
        git_branch: "trunk-a",
        git_commit_sha: "aaaa",
        ls_attribution_identifier: "Alpha Owner",
      };
    };
    const first = turnAttributionWithToolOrigins(readTurnRecord(path)!, resolve);
    const second = turnAttributionWithToolOrigins(readTurnRecord(path)!, resolve);

    expect(first).toMatchObject({ repository_name: "acme/a", git_branch: "trunk-a" });
    expect(second).toEqual(first);
    expect(resolutions).toBe(1);
  });

  it("keeps saved tool order ahead of timestamp order", () => {
    const path = turnRecordPath(join(sandbox.root, "state.json"), "origin-order", "root");
    const origin = "account";
    recordRun({
      path,
      run: {
        id: "root",
        name: "turn",
        run_type: "chain",
        trace_id: "root",
        dotted_order: "root",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
    });
    recordRun({
      path,
      run: {
        id: "read-run",
        name: "Read",
        run_type: "tool",
        trace_id: "root",
        parent_run_id: "root",
        dotted_order: "root.z",
        extra: { metadata: { repository_name: "acme/a" } },
      },
      tracing: "full",
      origin,
      toolUseId: "use-read",
    });
    recordRun({
      path,
      run: {
        id: "write-run",
        name: "Write",
        run_type: "tool",
        trace_id: "root",
        parent_run_id: "root",
        dotted_order: "root.a",
        extra: { metadata: { repository_name: "acme/b" } },
      },
      tracing: "full",
      origin,
      toolUseId: "use-write",
    });
    recordToolOrigin(path, origin, "full", {
      toolUseId: "use-read",
      toolName: "Read",
      order: 0,
      origin: { path: join(alpha, "seed.txt"), cwd: plain, namedAPath: true },
    });
    recordToolOrigin(path, origin, "full", {
      toolUseId: "use-write",
      toolName: "Write",
      order: 1,
      origin: { path: join(beta, "seed.txt"), cwd: plain, namedAPath: true },
    });

    expect(turnAttributionWithToolOrigins(readTurnRecord(path)!)).toMatchObject({
      repository_name: "acme/a",
    });
  });

  it("does not let an unrecorded tool origin outrank captured children", () => {
    const path = turnRecordPath(join(sandbox.root, "state.json"), "origin-captured", "root");
    const origin = "account";
    recordRun({
      path,
      run: {
        id: "root",
        name: "turn",
        run_type: "chain",
        trace_id: "root",
        dotted_order: "root",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
    });
    recordRun({
      path,
      run: {
        id: "write-run",
        name: "Write",
        run_type: "tool",
        trace_id: "root",
        parent_run_id: "root",
        dotted_order: "root.a",
        extra: { metadata: { repository_name: "acme/b" } },
      },
      tracing: "full",
      origin,
      toolUseId: "use-write",
    });
    recordToolOrigin(path, origin, "full", {
      toolUseId: "use-read",
      toolName: "Read",
      order: 0,
      origin: { path: join(alpha, "seed.txt"), cwd: plain, namedAPath: true },
    });

    expect(
      turnAttributionWithToolOrigins(readTurnRecord(path)!, () => ({ repository_name: "acme/a" })),
    ).toMatchObject({ repository_name: "acme/b" });
  });

  it("does not reuse a later same-name tool run for an earlier origin", () => {
    const path = turnRecordPath(join(sandbox.root, "state.json"), "origin-same-name", "root");
    const origin = "account";
    recordRun({
      path,
      run: {
        id: "root",
        name: "turn",
        run_type: "chain",
        trace_id: "root",
        dotted_order: "root",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
    });
    recordRun({
      path,
      run: {
        id: "later-read-run",
        name: "Read",
        run_type: "tool",
        trace_id: "root",
        parent_run_id: "root",
        dotted_order: "root.a",
        extra: { metadata: { repository_name: "acme/b" } },
      },
      tracing: "full",
      origin,
      toolUseId: "use-read-later",
    });
    recordToolOrigin(path, origin, "full", {
      toolUseId: "use-read-earlier",
      toolName: "Read",
      order: 0,
      origin: { path: join(alpha, "seed.txt"), cwd: plain, namedAPath: true },
    });
    recordToolOrigin(path, origin, "full", {
      toolUseId: "use-read-later",
      toolName: "Read",
      order: 1,
      origin: { path: join(beta, "seed.txt"), cwd: plain, namedAPath: true },
    });

    const resolvedPaths: string[] = [];
    turnAttributionWithToolOrigins(readTurnRecord(path)!, (_base, toolOrigin) => {
      resolvedPaths.push(toolOrigin.path ?? "");
      return {
        repository_name: toolOrigin.path === join(alpha, "seed.txt") ? "acme/a" : "acme/b",
      };
    });

    const record = readTurnRecord(path)!;
    expect(resolvedPaths).toEqual([join(alpha, "seed.txt")]);
    expect(record.toolOrigins[0]?.resolvedMetadata).toEqual({ repository_name: "acme/a" });
    expect(record.children[0]?.toolUseId).toBe("use-read-later");
  });

  // Catches a sub-task and everything under it being built from what the session knew
  // at the start, so the Task, the subagent and its model calls arrive with no author.
  it("gives a sub-task and the runs beneath it the repository and the author", async () => {
    const base = session("subagent-born-known", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    await subagent(base, "agent-7");
    await task(base, "agent-7");
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
    ]);
    await stop(base);

    const attributed = {
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    };
    expect(await waitFor(() => service.created.some((run) => run.name === "Agent"))).toBe(true);
    expect(createdMetadataOf(base.session_id, "Agent")).toMatchObject(attributed);
    expect(
      await waitFor(
        () => createdMetadataOf(base.session_id, "Explore Subagent").repository_name === "acme/a",
      ),
    ).toBe(true);
    expect(createdMetadataOf(base.session_id, "Explore Subagent")).toMatchObject(attributed);
    expect(
      await waitFor(() =>
        createdMetadataAll(base.session_id, "Claude").some(
          (metadata) => metadata.ls_agent_type === "subagent",
        ),
      ),
    ).toBe(true);
    const beneath = createdMetadataAll(base.session_id, "Claude").filter(
      (metadata) => metadata.ls_agent_type === "subagent",
    );
    expect(beneath).toHaveLength(1);
    expect(beneath[0]).toMatchObject(attributed);
  });

  // Catches an interrupted turn's model calls being backfilled from what the session knew
  // at the start, so a turn nobody stopped is the one turn that loses its author.
  it("gives an interrupted turn's model calls the repository and the author", async () => {
    const base = session("interrupted-fill", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    // The uploader works the repository out, so wait for that call to land before the
    // interrupted turn asks the record where it worked.
    expect(await waitFor(() => service.created.some((run) => run.name === "Read"))).toBe(true);
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
    ]);
    await prompt(base);

    expect(await waitFor(() => createdMetadataAll(base.session_id, "Claude").length > 0)).toBe(
      true,
    );
    expect(createdMetadataAll(base.session_id, "Claude")[0]).toMatchObject({
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    });
  });

  // Catches the write that closes a background agent being rebuilt from what the session
  // knew at startup, which lands on top of the good metadata and clears it for good.
  it("closes a background agent carrying the repository the turn worked out", async () => {
    const base = session("background-open", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    expect(await waitFor(() => metadataOf("Read").repository_name === "acme/a")).toBe(true);
    await task(base, "agent-bg1");
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
    ]);
    await stop(base);

    // The agent finishes in the background, so its run is posted open here.
    await subagent(base, "agent-bg1");
    await notification(base, "agent-bg1");
    appendReply(base, 2);
    await stop(base);

    const agentRunId = service.created.find((run) => run.name === "Agent")?.id;
    expect(agentRunId).toBeDefined();
    expect(await waitFor(() => service.updated.some((run) => run.id === agentRunId))).toBe(true);
    const attributed = {
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    };
    expect(metadataOf("Agent")).toMatchObject(attributed);
    expect(
      await waitFor(() =>
        Object.entries(attributed).every(
          ([key, value]) => metadataOf("Claude Code Turn")[key] === value,
        ),
      ),
    ).toBe(true);
    expect(metadataOf("Claude Code Turn")).toMatchObject(attributed);
  });

  it("labels the turn that reports a background agent back", async () => {
    const base = session("background-notify", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    expect(await waitFor(() => metadataOf("Read").repository_name === "acme/a")).toBe(true);
    await task(base, "agent-bg3");
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
      {
        id: "use-agent-bg3",
        name: "Task",
        input: { prompt: "go and look" },
        agentId: "agent-bg3",
      },
    ]);
    await stop(base);

    await subagent(base, "agent-bg3");
    await notification(base, "agent-bg3");
    appendReply(base, 2);
    await stop(base);

    const attributed = {
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    };
    const turns = service.created.filter(
      (run) =>
        run.name === "Claude Code Turn" && run.extra?.metadata?.thread_id === base.session_id,
    );
    expect(turns).toHaveLength(2);
    const secondTurn = turns.find((run) => run.extra?.metadata?.turn_number === 2)!;
    const models = () =>
      service.created.filter(
        (run) =>
          run.name === "Claude" &&
          run.extra?.metadata?.thread_id === base.session_id &&
          run.extra?.metadata?.ls_agent_type === "root",
      );
    expect(
      await waitFor(
        () => models().filter((run) => run.parent_run_id === secondTurn.id).length === 1,
      ),
    ).toBe(true);
    const secondModels = models().filter((run) => run.parent_run_id === secondTurn.id);
    expect(secondModels).toHaveLength(1);
    expect(secondModels[0].extra?.metadata).toMatchObject(attributed);

    expect(
      await waitFor(() => {
        const metadata = { ...secondTurn.extra?.metadata };
        for (const update of service.updated.filter((run) => run.id === secondTurn.id)) {
          Object.assign(metadata, update.extra?.metadata);
        }
        return Object.entries(attributed).every(([key, value]) => metadata[key] === value);
      }),
    ).toBe(true);
  });

  it("posts a notification model with launch attribution after the Agent upload settles", async () => {
    const base = session("background-notify-delayed-receipt", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    expect(await waitFor(() => metadataOf("Read").repository_name === "acme/a")).toBe(true);
    await task(base, "agent-bg-delayed");
    reply(base, 1, [
      { id: "use-Read", name: "Read", input: { file_path: join(alpha, "seed.txt") } },
      {
        id: "use-agent-bg-delayed",
        name: "Task",
        input: { prompt: "go and look" },
        agentId: "agent-bg-delayed",
      },
    ]);
    await stop(base);

    const launchRecord = recordFiles(base.session_id)
      .map((name) => readTurnRecord(join(recordDir(base.session_id), name)))
      .find((record) => record?.root?.metadata.turn_number === 1);
    expect(launchRecord).toBeDefined();
    expect(launchRecord?.closed).toBe(false);
    expect(
      recordFiles(base.session_id)
        .map((name) => readTurnRecord(join(recordDir(base.session_id), name)))
        .some((record) => record?.root?.metadata.turn_number === 2),
    ).toBe(false);

    const heldAgentUpload = service.holdNextUploadNamed("Agent");
    await subagent(base, "agent-bg-delayed");
    await heldAgentUpload.entered;
    try {
      const openLaunchRecord = recordFiles(base.session_id)
        .map((name) => readTurnRecord(join(recordDir(base.session_id), name)))
        .find((record) => record?.root?.metadata.turn_number === 1);
      expect(openLaunchRecord?.closed).toBe(false);
      expect(openLaunchRecord?.children.some((run) => run.name === "Agent")).toBe(true);
      expect(
        recordFiles(base.session_id)
          .map((name) => readTurnRecord(join(recordDir(base.session_id), name)))
          .some((record) => record?.root?.metadata.turn_number === 2),
      ).toBe(false);
      await notification(base, "agent-bg-delayed");
      appendReply(base, 2);
      await stop(base);
      const notificationRecord = recordFiles(base.session_id)
        .map((name) => readTurnRecord(join(recordDir(base.session_id), name)))
        .find((record) => record?.root?.metadata.turn_number === 2);
      const notificationModel = notificationRecord?.children.find(
        (run) => run.name === "Claude" && run.parent_run_id === notificationRecord.root?.run_id,
      );
      expect(notificationModel).toBeDefined();
      const sourceRef = `${notificationRecord!.root!.run_id}${CLAUDE_RUN_SNAPSHOT_SOURCE_SEPARATOR}${notificationModel!.run_id}${CLAUDE_RUN_SNAPSHOT_EVENT_SUFFIX}`;
      const reconstruction = {
        integration: CLAUDE_CODE_INTEGRATION,
        sessionId: base.session_id,
        accountFingerprint: notificationRecord!.origin,
        turnId: notificationRecord!.root!.run_id,
        eventId: `${notificationModel!.run_id}${CLAUDE_RUN_RECONSTRUCTION_EVENT_SUFFIX}`,
        sourceRefs: [sourceRef],
        privacyMode: "full",
        turnEvidence: {
          rootRunId: notificationModel!.trace_id,
          childRunIds: [notificationModel!.run_id],
          closureState: "authoritative",
        },
        sourceSnapshots: [
          {
            sourceRef,
            sourceAgeStartedAtMs: Date.now(),
            submission: {
              operation: "post",
              integration: CLAUDE_CODE_INTEGRATION,
              privacyMode: "full",
              metadata: {
                integration: CLAUDE_CODE_INTEGRATION,
                threadId: base.session_id,
                runType: "root",
                agentType: "root",
              },
              privacyContext: { status: "completed" },
              run: {
                id: notificationModel!.run_id,
                name: notificationModel!.name,
                run_type: notificationModel!.run_type,
                start_time: notificationModel!.start_time,
                parent_run_id: notificationModel!.parent_run_id,
                trace_id: notificationModel!.trace_id,
                dotted_order: notificationModel!.dotted_order,
                inputs: {},
              },
            },
          },
        ],
      } as unknown as ReconstructionJob;
      expect(
        reconstructClaudeRun(reconstruction, {
          project: "reconcile-e2e",
          recordOrigin: notificationRecord!.origin,
          sessionId: base.session_id,
          stateFilePath: join(sandbox.root, "state.json"),
        }).status,
      ).toBe("deferred");
      expect(
        service.started.some(
          (wire) => wire.action === "post" && wire.run.id === notificationModel?.run_id,
        ),
      ).toBe(false);
    } finally {
      heldAgentUpload.release();
    }

    const attributed = {
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    };
    expect(
      await waitFor(() => {
        const notificationTurn = service.created.find(
          (run) =>
            run.name === "Claude Code Turn" &&
            run.extra?.metadata?.thread_id === base.session_id &&
            run.extra?.metadata?.turn_number === 2,
        );
        return (
          notificationTurn !== undefined &&
          service.created.some(
            (run) => run.name === "Claude" && run.parent_run_id === notificationTurn.id,
          )
        );
      }),
    ).toBe(true);
    const notificationTurn = service.created.find(
      (run) =>
        run.name === "Claude Code Turn" &&
        run.extra?.metadata?.thread_id === base.session_id &&
        run.extra?.metadata?.turn_number === 2,
    )!;
    const notificationModel = service.created.find(
      (run) => run.name === "Claude" && run.parent_run_id === notificationTurn.id,
    );
    expect(notificationModel?.extra?.metadata).toMatchObject(attributed);
  });

  it("waits for every matching Agent launch receipt before posting a notification model", async () => {
    const stateFilePath = join(sandbox.root, "delayed-notification-state.json");
    const sessionId = "delayed-notification";
    const config = {
      apiKey: "test-key",
      apiBaseUrl: "https://api.example",
      stateFilePath,
      redact: false,
    } as unknown as Parameters<typeof acknowledgeClaudeSharedDeliveries>[1];
    const origin = queueOrigin(config);
    const launchRunId = "launch-turn";
    const agentRunId = "launch-agent";
    const notificationRunId = "notification-turn";
    const modelRunId = "notification-model";
    const launchPath = turnRecordPath(stateFilePath, sessionId, launchRunId);
    const attributed = {
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    };
    recordRun({
      path: launchPath,
      run: {
        id: launchRunId,
        name: "Claude Code Turn",
        run_type: "chain",
        trace_id: launchRunId,
        dotted_order: "launch",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
      shared: true,
    });
    for (const [id, name, dottedOrder, metadata] of [
      ["launch-read", "Read", "launch.read", attributed],
      [agentRunId, "Agent", "launch.agent", {}],
      ["launch-other", "Explore Subagent", "launch.other", {}],
    ] as const) {
      recordRun({
        path: launchPath,
        run: {
          id,
          name,
          run_type: "tool",
          parent_run_id: launchRunId,
          trace_id: launchRunId,
          dotted_order: dottedOrder,
          extra: { metadata },
        },
        tracing: "full",
        origin,
        shared: true,
      });
    }
    const captureStore = createCaptureStore(join(sandbox.root, "delayed-notification-captures"));
    let wakeCount = 0;
    const engineContext = {
      accountFingerprint: "current-account",
      captureStore,
      destinations: [{ id: "current-account" }],
      project: "test",
      recordOrigin: origin,
      session: {
        async wake() {
          wakeCount += 1;
        },
      },
      sessionId,
      stateFilePath,
      storageRoot: join(sandbox.root, "delayed-notification-captures"),
    } as unknown as Parameters<typeof acknowledgeClaudeSharedDeliveries>[0];
    const captureLaunchChild = async (id: string, delivered: boolean) => {
      const scope = {
        integration: CLAUDE_CODE_INTEGRATION,
        sessionId,
        turnId: launchRunId,
        eventId: id,
      };
      await captureStore.capture({
        ...scope,
        runId: id,
        destinationFingerprint: engineContext.accountFingerprint,
        eventKind: "test-run-v1",
        normalizedPayload: {},
        turnEvidence: {},
        metadataProvenance: {
          integration: CLAUDE_CODE_INTEGRATION,
          threadId: sessionId,
          runType: "tool",
          agentType: "root",
        },
      });
      if (delivered) {
        await captureStore.recordOutcome({
          ...scope,
          destination: engineContext.accountFingerprint,
          outcome: "delivered",
        });
      }
    };
    await captureLaunchChild("launch-read", true);
    await captureLaunchChild(agentRunId, false);
    await captureLaunchChild("launch-other", false);
    await acknowledgeClaudeSharedDeliveries(engineContext, config, sessionId);
    expect(wakeCount).toBe(1);
    recordRun({
      path: turnRecordPath(stateFilePath, sessionId, notificationRunId),
      run: {
        id: notificationRunId,
        name: "Claude Code Turn",
        run_type: "chain",
        parent_run_id: agentRunId,
        trace_id: launchRunId,
        dotted_order: "launch.agent.notification",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
      shared: true,
    });
    const sourceRef = `${notificationRunId}:${modelRunId}${CLAUDE_RUN_SNAPSHOT_EVENT_SUFFIX}`;
    const source = {
      operation: "post",
      integration: CLAUDE_CODE_INTEGRATION,
      privacyMode: "full",
      metadata: {
        integration: CLAUDE_CODE_INTEGRATION,
        threadId: sessionId,
        runType: "root",
        agentType: "root",
      },
      privacyContext: { status: "completed" },
      run: {
        id: modelRunId,
        name: "Claude",
        run_type: "llm",
        start_time: "2026-10-10T00:00:00.000Z",
        parent_run_id: notificationRunId,
        trace_id: launchRunId,
        dotted_order: "launch.agent.notification.model",
        inputs: {},
      },
    } as const;
    const notificationPath = turnRecordPath(stateFilePath, sessionId, notificationRunId);
    recordRun({
      path: notificationPath,
      run: { ...source.run, extra: { metadata: {} } },
      tracing: "full",
      origin,
      shared: true,
    });
    const job = {
      integration: CLAUDE_CODE_INTEGRATION,
      sessionId,
      accountFingerprint: "current-account",
      turnId: notificationRunId,
      eventId: `${modelRunId}${CLAUDE_RUN_RECONSTRUCTION_EVENT_SUFFIX}`,
      sourceRefs: [sourceRef],
      privacyMode: "full",
      turnEvidence: {
        rootRunId: launchRunId,
        childRunIds: [modelRunId],
        closureState: "authoritative",
      },
      sourceSnapshots: [{ sourceRef, sourceAgeStartedAtMs: Date.now(), submission: source }],
    } as unknown as ReconstructionJob;
    const context = { project: "test", recordOrigin: origin, sessionId, stateFilePath };

    const beforeReceipts = reconstructClaudeRun(job, context);
    expect(beforeReceipts.status).toBe("deferred");

    for (const id of [agentRunId, "launch-other"]) {
      await captureStore.recordOutcome({
        integration: CLAUDE_CODE_INTEGRATION,
        sessionId,
        turnId: launchRunId,
        eventId: id,
        destination: engineContext.accountFingerprint,
        outcome: "delivered",
      });
    }
    await acknowledgeClaudeSharedDeliveries(engineContext, config, sessionId);
    expect(wakeCount).toBe(2);
    const afterReceipts = reconstructClaudeRun(job, context);
    expect(afterReceipts.status).toBe("ready");
    if (afterReceipts.status !== "ready") return;
    expect(afterReceipts.outputs[0]?.submission.operation).toBe("post");
    expect(afterReceipts.outputs[0]?.submission.metadata.base).toMatchObject(attributed);
    expect(readTurnRecord(notificationPath)?.delivered.has(modelRunId)).toBe(false);
  });

  it.each([
    { label: "same-origin launch", launchOrigin: "current-origin", nested: false },
    { label: "nested same-origin launch", launchOrigin: "current-origin", nested: true },
    { label: "foreign-origin launch", launchOrigin: "foreign-origin", nested: false },
  ])("keeps current turn attribution for a $label", ({ launchOrigin, nested }) => {
    const stateFilePath = join(sandbox.root, "unmatched-notification-state.json");
    const sessionId = "unmatched-notification";
    const traceRootId = nested ? "outer-trace-root" : "foreign-launch-turn";
    const launchRunId = nested ? "nested-launch-turn" : traceRootId;
    const launchDottedOrder = nested ? "outer.agent.notification" : "foreign-launch";
    const agentRunId = "foreign-agent";
    const notificationRunId = "unmatched-notification-turn";
    const modelRunId = "unmatched-notification-model";
    const launchPath = turnRecordPath(stateFilePath, sessionId, launchRunId);
    const currentOrigin = "current-origin";
    if (nested) {
      const traceRootPath = turnRecordPath(stateFilePath, sessionId, traceRootId);
      recordRun({
        path: traceRootPath,
        run: {
          id: traceRootId,
          name: "Claude Code Turn",
          run_type: "chain",
          trace_id: traceRootId,
          dotted_order: "outer",
          extra: { metadata: {} },
        },
        tracing: "full",
        origin: currentOrigin,
        root: true,
        shared: true,
      });
      recordRun({
        path: traceRootPath,
        run: {
          id: "outer-agent",
          name: "Agent",
          run_type: "tool",
          parent_run_id: traceRootId,
          trace_id: traceRootId,
          dotted_order: "outer.agent",
          extra: { metadata: {} },
        },
        tracing: "full",
        origin: currentOrigin,
        shared: true,
      });
    }
    recordRun({
      path: launchPath,
      run: {
        id: launchRunId,
        name: "Claude Code Turn",
        run_type: "chain",
        ...(nested ? { parent_run_id: "outer-agent" } : {}),
        trace_id: traceRootId,
        dotted_order: launchDottedOrder,
        extra: { metadata: {} },
      },
      tracing: "full",
      origin: launchOrigin,
      root: true,
      shared: true,
    });
    recordRun({
      path: launchPath,
      run: {
        id: agentRunId,
        name: "Agent",
        run_type: "tool",
        parent_run_id: launchRunId,
        trace_id: traceRootId,
        dotted_order: `${launchDottedOrder}.agent`,
        extra: { metadata: { repository_name: "acme/a" } },
      },
      tracing: "full",
      origin: launchOrigin,
      shared: true,
    });
    const notificationPath = turnRecordPath(stateFilePath, sessionId, notificationRunId);
    recordRun({
      path: notificationPath,
      run: {
        id: notificationRunId,
        name: "Claude Code Turn",
        run_type: "chain",
        parent_run_id: agentRunId,
        trace_id: traceRootId,
        dotted_order: `${launchDottedOrder}.agent.notification`,
        extra: {
          metadata: {
            repository_name: "acme/b",
            git_branch: "trunk-b",
            ls_attribution_identifier: "Beta Owner",
          },
        },
      },
      tracing: "full",
      origin: currentOrigin,
      root: true,
      shared: true,
    });
    const sourceRef = `${notificationRunId}:${modelRunId}${CLAUDE_RUN_SNAPSHOT_EVENT_SUFFIX}`;
    const source = {
      operation: "post",
      integration: CLAUDE_CODE_INTEGRATION,
      privacyMode: "full",
      metadata: {
        integration: CLAUDE_CODE_INTEGRATION,
        threadId: sessionId,
        runType: "root",
        agentType: "root",
      },
      privacyContext: { status: "completed" },
      run: {
        id: modelRunId,
        name: "Claude",
        run_type: "llm",
        start_time: "2026-10-10T00:00:00.000Z",
        parent_run_id: notificationRunId,
        trace_id: traceRootId,
        dotted_order: `${launchDottedOrder}.agent.notification.model`,
        inputs: {},
      },
    } as const;
    const job = {
      integration: CLAUDE_CODE_INTEGRATION,
      sessionId,
      accountFingerprint: "current-account",
      turnId: notificationRunId,
      eventId: `${modelRunId}${CLAUDE_RUN_RECONSTRUCTION_EVENT_SUFFIX}`,
      sourceRefs: [sourceRef],
      privacyMode: "full",
      turnEvidence: {
        rootRunId: traceRootId,
        childRunIds: [modelRunId],
        closureState: "authoritative",
      },
      sourceSnapshots: [{ sourceRef, sourceAgeStartedAtMs: Date.now(), submission: source }],
    } as unknown as ReconstructionJob;

    const context = {
      project: "test",
      recordOrigin: currentOrigin,
      sessionId,
      stateFilePath,
    };
    const beforeReceipt = reconstructClaudeRun(job, context);
    expect(beforeReceipt.status).toBe(launchOrigin === currentOrigin ? "deferred" : "ready");
    if (launchOrigin === currentOrigin) recordDelivered(launchPath, agentRunId, currentOrigin);
    const result = reconstructClaudeRun(job, context);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.outputs[0]?.submission.metadata.base).toMatchObject({
      repository_name: "acme/b",
      git_branch: "trunk-b",
      ls_attribution_identifier: "Beta Owner",
    });
  });

  // Catches the same gap on the other route: a killed agent's run is never posted open,
  // so it is created already closed and there is no earlier write to fall back on.
  it("creates a killed agent's run carrying the repository the turn worked out", async () => {
    const base = session("background-killed", plain);
    await prompt(base);
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    expect(await waitFor(() => metadataOf("Read").repository_name === "acme/a")).toBe(true);
    await task(base, "agent-bg2");
    reply(base);
    await stop(base);

    // No SubagentStop ever fires for a killed agent.
    await notification(base, "agent-bg2", "killed");
    appendReply(base, 2);
    await stop(base);

    expect(await waitFor(() => service.created.some((run) => run.name === "Agent"))).toBe(true);
    expect(service.updated.some((run) => run.name === "Agent")).toBe(false);
    expect(metadataOf("Agent")).toMatchObject({
      repository_name: "acme/a",
      git_branch: "trunk-a",
      ls_attribution_identifier: "Alpha Owner",
    });
  });

  it("retries a refused turn closure without duplicating its tool runs", async () => {
    const base = session("late-handler", plain);
    await prompt(base);
    // Nothing here says where the turn worked.
    await tool(base, "Bash", { command: "echo hi" });
    expect(await waitFor(() => service.created.some((run) => run.name === "Bash"))).toBe(true);

    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    await tool(base, "Edit", { file_path: join(beta, "seed.txt") });
    expect(
      await waitFor(() =>
        ["Read", "Edit"].every((name) => service.created.some((run) => run.name === name)),
      ),
    ).toBe(true);
    const turnRunId = service.created.find((run) => run.name === "Claude Code Turn")?.id;
    expect(turnRunId).toBeDefined();
    service.failOnce = { action: "patch", id: turnRunId! };
    reply(base);
    await stop(base);
    expect(
      await waitFor(
        () =>
          service.attempts.filter((wire) => wire.action === "patch" && wire.run.id === turnRunId)
            .length >= 2,
      ),
    ).toBe(true);
    expect(await waitFor(() => service.updated.some((run) => run.id === turnRunId))).toBe(true);
    expect(await waitFor(() => recordFiles("late-handler").length === 0)).toBe(true);

    const turn = metadataOf("Claude Code Turn");
    expect(turn.repository_name).toBe("acme/a");
    expect(turn.ls_attribution_identifier).toBe("Alpha Owner");
    expect(metadataOf("Read").repository_name).toBe("acme/a");
    expect(metadataOf("Bash").repository_name).toBe("acme/a");
    // A call that reached into the other checkout keeps it.
    expect(metadataOf("Edit")).toMatchObject({
      repository_name: "acme/b",
      ls_attribution_identifier: "Beta Owner",
    });
  });

  // Catches a reconcile that records success before the service accepted the change, so
  // a failed patch is never retried and the metadata is lost without a trace.
  it("retries a patch the service refused and leaves no duplicate behind", async () => {
    const base = session("failed-patch", plain);
    await prompt(base);
    await tool(base, "Bash", { command: "echo hi" });
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    await waitFor(() =>
      ["Bash", "Read"].every((name) => service.created.some((run) => run.name === name)),
    );

    service.fail = true;
    reply(base);
    await stop(base);
    const turnRunId = service.created.find((run) => run.name === "Claude Code Turn")?.id;
    expect(turnRunId).toBeDefined();
    expect(
      await waitFor(() =>
        service.attempts.some((wire) => wire.action === "patch" && wire.run.id === turnRunId),
      ),
    ).toBe(true);
    expect(service.updated.some((run) => run.id === turnRunId)).toBe(false);

    service.fail = false;
    await stop(base);
    expect(await waitFor(() => metadataOf("Bash").repository_name === "acme/a")).toBe(true);
    expect(await waitFor(() => metadataOf("Claude Code Turn").repository_name === "acme/a")).toBe(
      true,
    );
    expect(service.created.filter((run) => run.name === "Bash")).toHaveLength(1);
  });

  // Catches a call queued while another uploader is busy never being sent, since that call
  // starts an uploader that would otherwise give up the moment it found the lock taken.
  it("uploads a call queued while another uploader was busy", async () => {
    const base = session("busy-uploader", alpha);
    await prompt(base);

    // Slow answers keep the first uploader holding the lock while the next call is queued.
    service.delayMs = 600;
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    await tool(base, "Glob", { path: join(alpha, "seed.txt") });
    service.delayMs = 0;

    expect(await waitFor(() => service.created.some((run) => run.name === "Glob"))).toBe(true);
  });

  // Catches a session ending without a stop leaving every call it was holding open running
  // for good, since only the stop hook used to say the turn was over.
  it("finishes the calls a session leaves behind when it ends without stopping", async () => {
    const base = session("no-stop", plain);
    await prompt(base);
    await tool(base, "Bash", { command: "echo hi" });
    await tool(base, "Read", { file_path: join(alpha, "seed.txt") });
    await hook("SessionEnd", { ...base, hook_event_name: "SessionEnd", reason: "clear" });

    expect(await waitFor(() => metadataOf("Bash").repository_name === "acme/a")).toBe(true);
    expect(await waitFor(() => recordFiles("no-stop").length === 0)).toBe(true);
  });

  // Catches a muted turn writing the repository, the author or the tool's own content
  // into the plugin's copy on disk, which is content a mute must never produce.
  it("writes nothing a muted turn should not have written", async () => {
    const base = session("muted", alpha);
    const muted = { CC_LANGSMITH_DEFAULT_MUTED: "true" };
    await hook(
      "UserPromptSubmit",
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "go" },
      muted,
    );
    await hook(
      "PostToolUse",
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: "use-Read",
        tool_input: { file_path: join(alpha, "secret.txt") },
        tool_response: { ok: true },
      },
      muted,
    );
    // Read the plugin's own copy while the turn is still open, since it goes once settled.
    const written = JSON.stringify(recordLines("muted"));
    expect(written).not.toContain("secret.txt");
    expect(written).not.toContain("acme/a");
    expect(written).not.toContain("Alpha Owner");

    reply(base);
    await hook("Stop", { ...base, hook_event_name: "Stop", last_assistant_message: "done" }, muted);

    expect(await waitFor(() => service.created.some((run) => run.name === "Read"))).toBe(true);
    expect(metadataOf("Read").repository_name).toBeUndefined();
    expect(JSON.stringify(service.created)).not.toContain("secret.txt");
  });
});
