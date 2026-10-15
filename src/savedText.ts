import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configuredMessagesSchema, isLocalizedText, localizedTextSchema, resolveLocalizedTextTree, type ConfiguredMessages } from '@wabs/plugin-sdk/configuration';
import type { PluginLifecycleContext, PluginConfigurationMigrationInput } from '@wabs/plugin-sdk/plugin-lifecycle';
import { eventsConfigSchema, localizeDefaultEventProfiles, localizeSubgroupSuggestionPreFlowNotice } from './config';
import { eventsMessages } from './messages';
import { eventTextDefinitions } from './messageDefinitions';

const namespace = 'official.community-events';
const portuguese = JSON.parse(readFileSync(path.join(__dirname, '..', 'locales', 'pt-PT', `${namespace}.json`), 'utf8')) as Record<string, string>;
export const eventMessageSeeds = { en: eventsMessages, 'pt-PT': portuguese };
const textFields = new Set(['label', 'prompt', 'optionalPromptSuffix', 'template', 'titleTemplate', 'descriptionTemplate', 'displayName']);
const messageVariables = new Map(eventTextDefinitions.map(definition => [definition.key, new Set(definition.variables)]));

export function seedMessages(existing?: unknown, catalogs: Record<string, Record<string, string>> = eventMessageSeeds): ConfiguredMessages {
  const saved = existing ? configuredMessagesSchema.parse(existing) : undefined;
  const locales = new Set([...Object.keys(catalogs), ...Object.keys(saved?.catalogs ?? {})]);
  return configuredMessagesSchema.parse({ version: 1, namespace, defaultLocale: saved?.defaultLocale ?? 'en',
    catalogs: Object.fromEntries([...locales].map(locale => [locale, {
      ...eventsMessages, ...(catalogs[locale] ?? {}), ...(saved?.catalogs[locale] ?? {})
    }])) });
}

/** Raw templates stay byte-for-byte intact. Only their container changes. */
export function materializeEventText(input: unknown, catalogs: Record<string, Record<string, string>> = eventMessageSeeds): Record<string, unknown> {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const messages = seedMessages(raw.messages, catalogs);
  const base = eventsConfigSchema.parse(resolveLocalizedTextTree(raw, messages.defaultLocale));
  const localized = Object.fromEntries(Object.entries(messages.catalogs).map(([locale, catalog]) => {
    const resolved = eventsConfigSchema.parse(resolveLocalizedTextTree(raw, locale));
    const t = (key: string) => catalog[key] ?? messages.catalogs[messages.defaultLocale]![key] ?? key;
    return [locale, { ...resolved,
      eventProfiles: localizeDefaultEventProfiles(resolved.eventProfiles, t),
      subgroupSuggestionConversion: { ...resolved.subgroupSuggestionConversion,
        preFlowNotice: raw.messages ? resolved.subgroupSuggestionConversion.preFlowNotice : localizeSubgroupSuggestionPreFlowNotice(resolved.subgroupSuggestionConversion.preFlowNotice, t) }
    }];
  }));
  function walk(value: unknown, original: unknown, variants: Record<string, unknown>, key = ''): unknown {
    if (isLocalizedText(original)) return localizedTextSchema.parse(original);
    if (typeof value === 'string' && textFields.has(key)) {
      const values = Object.fromEntries(Object.entries(variants).map(([locale, variant]) => [locale,
        typeof original === 'string' && variant === value ? original : typeof variant === 'string' ? variant : value]));
      return { $text: values, defaultLocale: messages.defaultLocale };
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, Array.isArray(original) ? original[index] : undefined,
      Object.fromEntries(Object.entries(variants).map(([locale, variant]) => [locale, Array.isArray(variant) ? variant[index] : undefined]))));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([child, item]) => [child,
      child === 'messages' ? messages : walk(item, record(original)[child], Object.fromEntries(Object.entries(variants).map(([locale, variant]) => [locale, record(variant)[child]])), child)]));
    return value;
  }
  const result = walk(base, raw, localized) as Record<string, unknown>;
  result.messages = messages;
  const conversion = result.subgroupSuggestionConversion as Record<string, unknown>;
  conversion.preFlowNotice = { ...record(conversion.preFlowNotice), textVersion: 1 };
  result.eventProfiles = (result.eventProfiles as Record<string, unknown>[]).map(profile => ({ ...profile, textVersion: 1 }));
  return result;
}

export const eventsStoredConfigSchema = z.unknown().transform((input, ctx) => {
  try {
    const result = materializeEventText(input);
    const messages = result.messages as ConfiguredMessages;
    // Validate every language, including v2 tokens, conditions and mention destinations.
    for (const locale of Object.keys(messages.catalogs)) eventsConfigSchema.parse(resolveLocalizedTextTree(result, locale));
    for (const [locale, catalog] of Object.entries(messages.catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        const seed = eventsMessages[key];
        if (seed === undefined) continue;
        if (!value.trim() && seed.trim()) throw new Error(`${key} (${locale}): text is required`);
        const allowed = messageVariables.get(key) ?? new Set<string>();
        for (const match of value.matchAll(/\{([A-Za-z0-9_]+)\}/gu)) {
          if (!allowed.has(match[1]!)) throw new Error(`${key} (${locale}): unknown variable ${match[1]}`);
        }
      }
    }
    return result;
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export function migrateEventTextLayers(input: PluginConfigurationMigrationInput) {
  return input.layers.filter(layer => layer.scopeId && !layer.identityId).map(layer => {
    const catalogs: Record<string, Record<string, string>> = structuredClone(eventMessageSeeds);
    for (const kind of ['GLOBAL', 'SCOPE']) {
      for (const pack of input.languagePacks ?? []) {
        if (pack.scopeKind !== kind || (kind === 'SCOPE' && pack.scopeId !== layer.scopeId)) continue;
        if (pack.catalogs[namespace]) catalogs[pack.locale] = { ...catalogs[pack.locale], ...pack.catalogs[namespace] };
      }
    }
    const lineage: string[] = [];
    let current = layer.scopeId;
    while (current) {
      if (lineage.includes(current)) throw new Error('Cannot snapshot a cyclic scope configuration.');
      lineage.unshift(current);
      current = input.scopes.find(scope => scope.id === current)?.parentScopeId ?? null;
    }
    let effective: Record<string, unknown> = {};
    for (const scopeId of lineage) effective = mergeRecords(effective, input.layers.find(item => item.scopeId === scopeId && !item.identityId)?.config ?? {});
    return { scopeId: layer.scopeId, config: materializeEventText(effective, catalogs) };
  });
}

export async function migrateEventText(ctx: PluginLifecycleContext): Promise<void> {
  if (!ctx.migrateConfiguration) throw new Error('Saved event wording requires configuration migration support.');
  await ctx.migrateConfiguration(`saved-event-text-v1-${(ctx.toVersion ?? 'initial').toLowerCase().replace(/[^a-z0-9.-]/gu, '-')}`, migrateEventTextLayers);
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function mergeRecords(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(previous);
  for (const [key, value] of Object.entries(next)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? mergeRecords(record(result[key]), value as Record<string, unknown>) : structuredClone(value);
  return result;
}
