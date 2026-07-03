/**
 * tmp-tag-seed-project.ts — TEMPORARY (tag integration smoke, not committed).
 *
 * Seeds one project into a persistent SYNARA_HOME sqlite via an in-process
 * `project.create` engine dispatch (projects have no HTTP create route — see
 * src/taskApi/README.md "Projects"). Run BEFORE booting the server against
 * the same SYNARA_HOME. Prints the projectId on stdout.
 *
 * Usage:
 *   SYNARA_HOME=<dir> SEED_WORKSPACE_ROOT=<dir> bun run scripts/tmp-tag-seed-project.ts
 */
import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../src/orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceConfig } from "../src/persistence/Layers/Sqlite.ts";

const synaraHome = process.env.SYNARA_HOME;
const workspaceRoot = process.env.SEED_WORKSPACE_ROOT;
if (!synaraHome || !workspaceRoot) {
  console.error("SYNARA_HOME and SEED_WORKSPACE_ROOT are required");
  process.exit(1);
}

// Same composition as taskApi.integration.test.ts, but on the PERSISTENT
// config-driven sqlite (SYNARA_HOME/userdata/state.sqlite) instead of memory.
const serverConfigLayer = ServerConfig.layerTest(process.cwd(), synaraHome);
const fullLayer = OrchestrationLayerLive.pipe(
  Layer.provideMerge(SqlitePersistenceConfig),
  Layer.provideMerge(serverConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const runtime = ManagedRuntime.make(fullLayer);
try {
  const projectId = ProjectId.makeUnsafe(randomUUID());
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      // dispatch resolves only after the command worker has persisted the
      // events (Deferred with the committed sequence) — safe to dispose after.
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`cmd-tag-smoke-seed-${randomUUID()}`),
        projectId,
        title: "tag smoke project",
        workspaceRoot,
        defaultModelSelection: { provider: "cursor", model: "auto" },
        createdAt: new Date().toISOString(),
      });
    }),
  );
  console.log(`PROJECT_ID=${projectId}`);
} finally {
  await runtime.dispose();
}
