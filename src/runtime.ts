import type { EventsDeploymentConfig } from './deploymentConfig';
import type { ManagedGroupPlugin, ManagedGroupCommandContext, ManagedGroupRuntimeContext,
  ManagedGroupServiceContext, ManagedGroupOperationContext, ManagedGroupCommandRuntime } from '@wabs/plugin-sdk/managed-group-plugin';
export { requireManagedGroupCommandRuntime as requireOfficialCommandRuntime } from '@wabs/plugin-sdk/managed-group-plugin';
export { requireScopeId } from '@wabs/plugin-sdk/commands';
export type BotPlugin = ManagedGroupPlugin<EventsDeploymentConfig>;
export type PluginCommandContext = ManagedGroupCommandContext<EventsDeploymentConfig>;
export type PluginOperationContext = ManagedGroupOperationContext<EventsDeploymentConfig>;
export type PluginRuntimeContext = ManagedGroupRuntimeContext<EventsDeploymentConfig>;
export type PluginServiceRegistrationContext = ManagedGroupServiceContext<EventsDeploymentConfig>;
export type OfficialPluginCommandRuntime = ManagedGroupCommandRuntime<EventsDeploymentConfig>;
export type { PluginGroupDismantleResult } from '@wabs/plugin-sdk/managed-group-operations';
export type { PluginPermissionExplanation, PluginScopedI18n as I18nService } from '@wabs/plugin-sdk/durable-plugin';
export type { PluginLogger as Logger, PluginLifecycleContext } from '@wabs/plugin-sdk/plugin-lifecycle';
export type { MessageCatalog, TranslateFn } from '@wabs/plugin-sdk/i18n';
export type { PluginCancellationRegistration } from '@wabs/plugin-sdk/cancellations';
export type { PluginGroupDismantledEvent, PluginJobEvent, PluginParticipantChangeEvent, PluginPollVote, PluginPollVotePluginEvent, PluginRuntimeHooks } from '@wabs/plugin-sdk/hooks';
export type { DurableFlowEngine as FlowEngine } from '@wabs/plugin-sdk/durable-flow';
export type { FlowSessionSnapshot, FlowStartOrigin, FlowStartResult } from '@wabs/plugin-sdk/flow-engine';
