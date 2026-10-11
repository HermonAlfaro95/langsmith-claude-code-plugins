import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  metadataAfterFill,
  reconcileAndClear,
  reconcileTurn,
  turnAttribution,
} from "./reconcile.js";
import { inAlpha, inBeta, record, recorded } from "./fixtures/turn-record-sandbox.js";
import {
  recordDelivered,
  recordRun,
  recordTurnClosed,
  readTurnRecord,
  turnRecordPath,
} from "./turn-record.js";
import { QUEUE_RUN_MAX_AGE_MS } from "./constants.js";

const bare = { cwd: "/somewhere", thread_id: "s1" };

function agentLaunchRecord(startTime: string | null = new Date().toISOString()) {
  const stateFilePath = join(mkdtempSync(join(tmpdir(), "claude-pending-records-")), "state.json");
  const sessionId = "session";
  const origin = "account";
  const launchRunId = "launch";
  const agentRunId = "agent";
  const launchPath = turnRecordPath(stateFilePath, sessionId, launchRunId);
  const notificationPath = turnRecordPath(stateFilePath, sessionId, "notification");
  recordRun({
    path: launchPath,
    run: {
      id: launchRunId,
      name: "Claude Code Turn",
      run_type: "chain",
      ...(typeof startTime === "string" ? { start_time: startTime } : {}),
      trace_id: launchRunId,
      dotted_order: "launch.root",
      extra: { metadata: { ...inAlpha } },
    },
    tracing: "full",
    origin,
    root: true,
    shared: true,
  });
  recordRun({
    path: launchPath,
    run: {
      id: agentRunId,
      name: "Agent",
      run_type: "tool",
      start_time: startTime,
      parent_run_id: launchRunId,
      trace_id: launchRunId,
      dotted_order: "launch.root.agent",
      extra: { metadata: {} },
    },
    tracing: "full",
    origin,
    shared: true,
  });
  recordDelivered(launchPath, agentRunId, origin);
  recordTurnClosed(launchPath, "launch-turn");
  return { launchPath, notificationPath, origin };
}

describe("what a turn settles on", () => {
  // Catches a reconcile that ignores the repository the session already configured and
  // goes looking at the tools instead, which relabels a whole turn from one stray call.
  it("keeps the repository the turn's own root already carries", () => {
    const turn = record({ ...bare, ...inAlpha }, [recorded("Glob", { ...bare, ...inBeta })]);

    expect(turnAttribution(turn)).toMatchObject({ repository_name: "acme/a" });
  });

  // Catches evidence picked in the order uploads finished rather than the order the
  // tools ran, which labels a turn from whichever call happened to answer first.
  it("takes the repository from the earliest tool call, not the first one recorded", () => {
    const turn = record(bare, [
      recorded("Edit", { ...bare, ...inAlpha }, 1),
      recorded("Glob", { ...bare, ...inBeta }, 2),
    ]);
    turn.children.reverse();

    expect(turnAttribution(turn)).toMatchObject({ repository_name: "acme/a" });
  });

  // Catches an author taken from a tool working in a different repository, which
  // credits one codebase's work to someone who never touched it.
  it("leaves the author alone when the only one on offer worked somewhere else", () => {
    const turn = record(bare, [
      recorded("Glob", { ...bare, repository_name: "acme/a" }, 1),
      recorded("Edit", { ...bare, ...inBeta }, 2),
    ]);

    expect(turnAttribution(turn)?.ls_attribution_identifier).toBeUndefined();
  });

  // Catches a turn that settles on nothing because no tool reached a repository, when
  // one of them still knew who was working.
  it("still names the author when nothing landed in a repository", () => {
    const turn = record(bare, [recorded("Bash", { ...bare, ls_attribution_identifier: "Nobody" })]);

    expect(turnAttribution(turn)).toEqual({ ls_attribution_identifier: "Nobody" });
  });

  // Catches a reconcile that invents an empty fill and patches every run with nothing,
  // which costs a request per run and rewrites metadata for no reason.
  it("settles on nothing when no run knew anything", () => {
    expect(turnAttribution(record(bare, [recorded("Bash", bare)]))).toBeUndefined();
  });
});

describe("what one run ends up with", () => {
  // Catches a fill that drops one repository's branch or commit onto another's name,
  // which is worse than leaving the gap.
  it("never mixes one repository's name with another's branch", () => {
    const partial = { ...bare, repository_name: "acme/b", git_branch: "trunk-b" };

    expect(metadataAfterFill(recorded("Edit", partial), inAlpha)).toBeUndefined();
  });

  // Catches a patch that sends only the repository keys, which drops everything else
  // the run already carried because an update replaces the whole metadata block.
  it("keeps every field the run already had", () => {
    const filled = metadataAfterFill(recorded("Bash", { ...bare, ls_tool_name: "Bash" }), inAlpha);

    expect(filled).toEqual({ ...bare, ls_tool_name: "Bash", ...inAlpha });
  });

  // Catches a reconcile that patches a run which already has everything, so every turn
  // costs a pointless request per run forever.
  it("asks for no change when the run already has it all", () => {
    expect(metadataAfterFill(recorded("Edit", { ...bare, ...inAlpha }), inAlpha)).toBeUndefined();
  });

  // Catches a fill that only adds the repository and leaves the author missing, when
  // the author is half of what the turn was reconciled for.
  it("fills the author onto a run that only knew the repository", () => {
    const run = recorded("Edit", { ...bare, repository_name: "acme/a" });

    expect(metadataAfterFill(run, inAlpha)).toMatchObject({
      ls_attribution_identifier: "Alpha Owner",
      git_branch: "trunk-a",
    });
  });
});

describe("letting go of a turn", () => {
  const nothingUploads = {
    client: undefined as never,
    replicas: undefined,
    watch: { failure: () => undefined },
  };

  it("leaves shared child closure to the shared engine while settling legacy children", async () => {
    const updateRun = vi.fn(async (_id: string, _run: unknown) => {});
    const shared = { ...recorded("shared", bare), shared: true, open: true };
    const legacy = { ...recorded("legacy", bare), open: true };
    const turn = record(bare, [shared, legacy], {
      path: join(mkdtempSync(join(tmpdir(), "claude-shared-reconcile-")), "turn.jsonl"),
    });
    turn.root!.shared = true;

    await expect(
      reconcileTurn({ ...nothingUploads, record: turn, client: { updateRun } as never }),
    ).resolves.toBe(true);
    expect(updateRun.mock.calls.map((args) => args[0])).toEqual(["legacy"]);
  });

  // Catches a turn nobody ever closed being kept on disk for good, since the age limit sat
  // behind the check for a close that never comes. No other test leaves a turn unfinished.
  it("gives up on a turn left unfinished for longer than the service will accept", async () => {
    const old = record(bare, [], { closed: false });
    old.root!.start_time = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    await expect(reconcileTurn({ record: old, ...nothingUploads })).resolves.toBe(true);
  });

  // Catches a turn settled while a tool call is still being uploaded, which fills it from
  // half the calls and can never be corrected, since a settled run is marked fixed for good.
  it("settles nothing while a tool call has yet to land", async () => {
    const waiting = record(bare, [
      recorded("Bash", bare, 1),
      recorded("Edit", { ...bare, ...inAlpha }, 2),
    ]);
    waiting.delivered = new Set(["Bash"]);
    const touched: string[] = [];
    const client = {
      createRun: (run: { id: string }) => touched.push(run.id),
      updateRun: (id: string) => touched.push(id),
    } as never;

    await expect(reconcileTurn({ ...nothingUploads, record: waiting, client })).resolves.toBe(
      false,
    );
    expect(touched).toEqual([]);
  });

  // Catches a turn still running being thrown away mid-flight, which loses every call
  // recorded for it so far.
  it("keeps a turn that is still running", async () => {
    const live = record(bare, [], { closed: false });

    await expect(reconcileTurn({ record: live, ...nothingUploads })).resolves.toBe(false);
  });

  it("keeps a closed Agent launch when no notification record exists yet", async () => {
    const { launchPath } = agentLaunchRecord();

    await reconcileAndClear({ record: readTurnRecord(launchPath)!, ...nothingUploads });

    expect(existsSync(launchPath)).toBe(true);
  });

  it("keeps an Agent launch when notification appears after record enumeration", async () => {
    const { launchPath, notificationPath, origin } = agentLaunchRecord();
    const staleSnapshot = readTurnRecord(launchPath)!;
    recordRun({
      path: notificationPath,
      run: {
        id: "notification",
        name: "Claude Code Turn",
        run_type: "chain",
        start_time: new Date().toISOString(),
        parent_run_id: "agent",
        trace_id: "launch",
        dotted_order: "launch.root.agent.notification",
        extra: { metadata: {} },
      },
      tracing: "full",
      origin,
      root: true,
      shared: true,
    });

    await reconcileAndClear({ record: staleSnapshot, ...nothingUploads });

    expect(existsSync(launchPath)).toBe(true);
    expect(turnAttribution(readTurnRecord(launchPath)!)).toMatchObject(inAlpha);
  });

  it("deletes a retained Agent launch once LangSmith's age limit passes", async () => {
    const started = Date.now() - 1000;
    const { launchPath } = agentLaunchRecord(new Date(started).toISOString());

    await reconcileAndClear({
      record: readTurnRecord(launchPath)!,
      ...nothingUploads,
      now: started + 2000,
    });
    expect(existsSync(launchPath)).toBe(true);

    await reconcileAndClear({
      record: readTurnRecord(launchPath)!,
      ...nothingUploads,
      now: started + QUEUE_RUN_MAX_AGE_MS,
    });

    expect(existsSync(launchPath)).toBe(false);
  });

  it.each([null, "not-a-date"])(
    "does not retain an Agent launch with root time %s",
    async (startTime) => {
      const { launchPath } = agentLaunchRecord(startTime);

      await reconcileAndClear({ record: readTurnRecord(launchPath)!, ...nothingUploads });

      expect(existsSync(launchPath)).toBe(false);
    },
  );
});
