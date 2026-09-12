import type { EventsDeploymentConfig } from './deploymentConfig';
import type { ManagedGroupPlugin, ManagedGroupCommandContext, ManagedGroupRuntimeContext,
  ManagedGroupServiceContext, ManagedGroupOperationContext, ManagedGroupCommandRuntime } from '../../../../packages/plugin-sdk/src/managed-group-plugin';
export { requireManagedGroupCommandRuntime as requireOfficialCommandRuntime } from '../../../../packages/plugin-sdk/src/managed-group-plugin';
export { requireScopeId } from '../../../../packages/plugin-sdk/src/commands';
export type BotPlugin = ManagedGroupPlugin<EventsDeploymentConfig>;
export type PluginCommandContext = ManagedGroupCommandContext<EventsDeploymentConfig>;
export type PluginOperationContext = ManagedGroupOperationContext<EventsDeploymentConfig>;
export type PluginRuntimeContext = ManagedGroupRuntimeContext<EventsDeploymentConfig>;
export type PluginServiceRegistrationContext = ManagedGroupServiceContext<EventsDeploymentConfig>;
export type OfficialPluginCommandRuntime = ManagedGroupCommandRuntime<EventsDeploymentConfig>;
export type { PluginGroupDismantleResult } from '../../../../packages/plugin-sdk/src/managed-group-operations';
export type { PluginPermissionExplanation, PluginScopedI18n as I18nService } from '../../../../packages/plugin-sdk/src/durable-plugin';
export type { PluginLogger as Logger, PluginLifecycleContext } from '../../../../packages/plugin-sdk/src/plugin-lifecycle';
export type { MessageCatalog, TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';
export type { PluginCancellationRegistration } from '../../../../packages/plugin-sdk/src/cancellations';
export type { PluginGroupDismantledEvent, PluginJobEvent, PluginParticipantChangeEvent, PluginPollVote, PluginPollVotePluginEvent, PluginRuntimeHooks } from '../../../../packages/plugin-sdk/src/hooks';
export type { DurableFlowEngine as FlowEngine } from '../../../../packages/plugin-sdk/src/durable-flow';
export type { FlowSessionSnapshot, FlowStartOrigin, FlowStartResult } from '../../../../packages/plugin-sdk/src/flow-engine';
