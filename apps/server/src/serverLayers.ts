import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AutomationRunReactorLive } from "./automation/Layers/AutomationRunReactor";
import { AutomationSchedulerLive } from "./automation/Layers/AutomationScheduler";
import { AutomationServiceLive } from "./automation/Layers/AutomationService";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { SubAgentApprovalResolverLive } from "./orchestration/Layers/SubAgentApprovalResolver";
import { SubAgentCascadeStopReactorLive } from "./orchestration/Layers/SubAgentCascadeStopReactor";
import { SubAgentOrchestratorLive } from "./orchestration/Layers/SubAgentOrchestrator";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";
import { SessionTokenRegistryLive } from "./subagentMcp/SessionTokenRegistry";
import { SubAgentMcpServerLive } from "./subagentMcp/SubAgentMcpServer";

import { DevServerManagerLive } from "./devServerManager";
import { KeybindingsLive } from "./keybindings";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitLayerLive, TextGenerationLayerLive } from "./git/runtimeLayer";
import { TerminalLayerLive } from "./terminal/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ProfileStatsQueryLive } from "./profileStats";
import { ProfileStatsArchiveLive } from "./profileStatsArchive";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";
import { AutomationRepositoryLive } from "./persistence/Layers/AutomationRepository";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns";

export { makeServerProviderLayer } from "./provider/runtimeLayer";

export function makeServerRuntimeServicesLayer() {
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(checkpointStoreLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    OrchestrationLayerLive,
    checkpointStoreLayer,
    checkpointDiffQueryLayer,
    RuntimeReceiptBusLive,
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const profileStatsArchiveLayer = ProfileStatsArchiveLive.pipe(
    Layer.provideMerge(checkpointStoreLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );
  const threadDeletionReactorLayer = ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(profileStatsArchiveLayer),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(TerminalLayerLive),
  );
  // Engine + projection come from OrchestrationLayerLive, mirroring
  // threadDeletionReactorLayer above -- the resolver only needs to observe
  // the domain-event stream and read/dispatch through the engine, no other
  // service.
  const subAgentApprovalResolverLayer = SubAgentApprovalResolverLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
  );
  // Engine + projection come from OrchestrationLayerLive, mirroring the sibling
  // reactors above. `GitCore` provisions isolated worktrees for
  // `workspace:"worktree"` spawns (Task 4.1), the same GitCore instance
  // AutomationService uses for its own worktree provisioning -- no cycle,
  // since GitCoreLive only depends on ServerConfig/platform services, not on
  // orchestration. `ProviderDiscoveryService` is intentionally left as an
  // unresolved requirement here -- it is satisfied by `makeServerProviderLayer()`
  // at the composition root (`main.ts`'s `LayerLive`), the same way
  // `providerCommandReactorLayer` above leaves `ProviderService` unresolved.
  const subAgentOrchestratorLayer = SubAgentOrchestratorLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(GitCoreLive),
  );
  // Task 5.3: reacts to `thread.session-stop-requested` by cascade-stopping
  // the stopping thread's LIVE sub-agent children (`SubAgentOrchestrator.cascadeStopChildren`).
  // Needs `SubAgentOrchestrator` (for `cascadeStopChildren`) and the engine's
  // domain-event stream, both already exposed by subAgentOrchestratorLayer.
  const subAgentCascadeStopReactorLayer = SubAgentCascadeStopReactorLive.pipe(
    Layer.provideMerge(subAgentOrchestratorLayer),
  );
  // The sub-agent MCP handler needs SubAgentOrchestrator (spawn/wait) and
  // ProjectionSnapshotQuery (resolving a caller's projectId/workspace from its
  // own thread row, decision #3 in the Task 2.2 brief) -- both already exposed
  // by subAgentOrchestratorLayer above, so provide it from there rather than
  // re-deriving OrchestrationLayerLive a second time.
  const subAgentMcpServerLayer = SubAgentMcpServerLive.pipe(
    Layer.provideMerge(subAgentOrchestratorLayer),
  );
  // Shares the single memoized TerminalManager with the top-level TerminalLayerLive.
  const devServerManagerLayer = DevServerManagerLive.pipe(Layer.provide(TerminalLayerLive));
  const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  const authControlPlaneLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
  );
  const serverAuthLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
  );
  const authServicesLayer = Layer.mergeAll(
    ServerAuthPolicyLive,
    ServerSecretStoreLive,
    BootstrapCredentialServiceLive,
    sessionCredentialLayer,
    authControlPlaneLayer,
    serverAuthLayer,
  );
  const automationServiceLayer = AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const automationSchedulerLayer = AutomationSchedulerLive.pipe(
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(AutomationRepositoryLive),
  );
  const automationRunReactorLayer = AutomationRunReactorLive.pipe(
    Layer.provideMerge(automationServiceLayer),
  );

  return Layer.mergeAll(
    automationServiceLayer,
    automationSchedulerLayer,
    automationRunReactorLayer,
    AutomationRepositoryLive,
    orchestrationReactorLayer,
    threadDeletionReactorLayer,
    subAgentApprovalResolverLayer,
    subAgentOrchestratorLayer,
    subAgentCascadeStopReactorLayer,
    subAgentMcpServerLayer,
    SessionTokenRegistryLive,
    devServerManagerLayer,
    GitLayerLive,
    TextGenerationLayerLive,
    TerminalLayerLive,
    KeybindingsLive,
    ServerSettingsLive,
    ServerEnvironmentLive,
    ProfileStatsQueryLive,
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}
