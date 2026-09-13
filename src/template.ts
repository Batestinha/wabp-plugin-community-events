import {
  conditionalTemplateIsActive,
  renderCheckedConditionalText,
  ConditionalTextConfigurationError,
  renameConditionalTemplateToken
} from '@wabs/plugin-sdk/templates';

export {
  ConditionalTemplateSyntaxError as EventTemplateSyntaxError,
  parseConditionalTemplate as parseEventTemplate,
  renameConditionalTemplateToken as renameEventTemplateToken,
  renderConditionalTemplate as renderEventTemplateText,
  validateConditionalTemplate as validateEventTemplateText,
  validateConditionalTemplateIfActive as validateEventConditionalText,
  validateConditionalTemplateSyntax as validateEventTemplateSyntax
} from '@wabs/plugin-sdk/templates';

export type {
  ConditionalTemplateNode as EventTemplateNode,
  ConditionalTemplateValidationIssue as EventTemplateValidationIssue
} from '@wabs/plugin-sdk/templates';

export type EventConditionalTextFailureCode =
  | 'invalid-template'
  | 'rendered-empty'
  | 'rendered-too-long'
  | 'duplicate-rendered-values';

export class EventConditionalTextConfigurationError extends Error {
  constructor(
    readonly field: string,
    readonly code: EventConditionalTextFailureCode
  ) {
    super(`Event conditional text configuration failed for ${field}: ${code}`);
    this.name = 'EventConditionalTextConfigurationError';
  }
}

export function renderEventConditionalText(input: {
  source: string;
  allowedTokens: Iterable<string>;
  values: Readonly<Record<string, string | undefined>>;
  emptyResult: 'reject' | 'suppress';
  field: string;
  maxLength?: number | undefined;
}): string | undefined {
  try { return renderCheckedConditionalText(input); } catch (error) {
    if (error instanceof ConditionalTextConfigurationError) {
      throw new EventConditionalTextConfigurationError(error.field, error.code);
    }
    throw error;
  }
}

export function renameEventConditionalTextToken(
  source: string,
  oldToken: string,
  newToken: string,
  allowedTokens: Iterable<string>
): string {
  const tokens = [...allowedTokens, oldToken, newToken];
  return conditionalTemplateIsActive(source, tokens)
    ? renameConditionalTemplateToken(source, oldToken, newToken)
    : source;
}
