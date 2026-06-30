import { randomUUID } from "node:crypto";

import {
  type OrchestrationCommand,
  ProjectId,
  type ProviderComposerCapabilities,
  SubAgentSpawnInput,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderUnsupportedError } from "../../provider/Errors.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../../provider/Services/ProviderDiscoveryService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { SubAgentError, SubAgentOrchestrator } from "../Services/SubAgentOrchestrator.ts";
import { SubAgentOrchestratorLive } from "./SubAgentOrchestrator.ts";

const decodeSpawnInput = Schema.decodeUnknownSync(SubAgentSpawnInput);

/**
 * A fake OrchestrationEngineService that records every dispatched command so a
 * test can assert on the exact command sequence spawn emits. Only `dispatch` is
 * meaningful; the read/stream members are inert (mirrors how reactor tests stub
 * out unused provider methods).
 */
function createRecordingEngine() {
  const commands: OrchestrationCommand[] = [];
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    getReadModel: () => Effect.die(new Error("getReadModel unused in test")),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    repairState: () => Effect.die(new Error("repairState unused in test")),
    streamDomainEvents: Stream.empty,
  };
  return { engine, commands };
}

/**
 * A stub ProviderDiscoveryService that reports the requested provider as either
 * available (getComposerCapabilities succeeds) or unavailable (fails with the
 * same ProviderUnsupportedError the real discovery layer raises for an
 * unregistered provider).
 */
function createDiscoveryStub(available: boolean): ProviderDiscoveryServiceShape {
  const unused = () => Effect.die(new Error("provider discovery method unused in test"));
  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    available
      ? Effect.succeed({
          provider: input.provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: false,
        } satisfies ProviderComposerCapabilities)
      : Effect.fail(new ProviderUnsupportedError({ provider: input.provider }));
  return {
    getComposerCapabilities,
    listCommands: unused,
    listSkills: unused,
    listPlugins: unused,
    readPlugin: unused,
    listModels: unused,
    listAgents: unused,
  };
}

function buildHarness(input: { readonly available: boolean }) {
  const { engine, commands } = createRecordingEngine();
  const layer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(input.available))),
  );
  const runtime = ManagedRuntime.make(layer);
  return { runtime, commands };
}

function makeCaller() {
  return {
    threadId: ThreadId.makeUnsafe(randomUUID()),
    projectId: ProjectId.makeUnsafe(randomUUID()),
    cwd: "/tmp/sub-agent-project",
    canSpawn: true,
  };
}

describe("SubAgentOrchestrator.spawn (share-cwd)", () => {
  it("dispatches thread.create then thread.turn.start for a shared-cwd child", async () => {
    const { runtime, commands } = buildHarness({ available: true });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const result = await runtime.runPromise(orchestrator.spawn(caller, input));

      expect(commands).toHaveLength(2);

      const createCommand = commands[0];
      if (createCommand?.type !== "thread.create") {
        throw new Error("expected the first dispatched command to be thread.create");
      }
      expect(createCommand.parentThreadId).toBe(caller.threadId);
      expect(createCommand.projectId).toBe(caller.projectId);
      expect(createCommand.subagentRole).toBeNull();
      expect(createCommand.subagentNickname).toBeNull();
      expect(createCommand.subagentAgentId).toBe(result.agentId);
      expect(createCommand.envMode).toBe("local");
      expect(createCommand.branch).toBeNull();
      expect(createCommand.worktreePath).toBeNull();
      expect(createCommand.threadId).toBe(result.agentId);

      const turnCommand = commands[1];
      if (turnCommand?.type !== "thread.turn.start") {
        throw new Error("expected the second dispatched command to be thread.turn.start");
      }
      expect(turnCommand.threadId).toBe(result.agentId);
      expect(turnCommand.message.text).toBe("validate");

      expect(result.agentId).toBe(createCommand.threadId);
    } finally {
      await runtime.dispose();
    }
  });

  it("fails with provider-unavailable when the provider is not available", async () => {
    const { runtime, commands } = buildHarness({ available: false });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const error = await runtime.runPromise(orchestrator.spawn(caller, input).pipe(Effect.flip));

      expect(error).toBeInstanceOf(SubAgentError);
      expect(error.reason).toBe("provider-unavailable");
      expect(commands).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});
