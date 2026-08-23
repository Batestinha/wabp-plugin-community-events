export {
  ConditionalTemplateSyntaxError as EventTemplateSyntaxError,
  parseConditionalTemplate as parseEventTemplate,
  renameConditionalTemplateToken as renameEventTemplateToken,
  renderConditionalTemplate as renderEventTemplateText,
  validateConditionalTemplate as validateEventTemplateText,
  validateConditionalTemplateSyntax as validateEventTemplateSyntax
} from '../../../platform/templates/conditionalTemplate';

export type {
  ConditionalTemplateNode as EventTemplateNode,
  ConditionalTemplateValidationIssue as EventTemplateValidationIssue
} from '../../../platform/templates/conditionalTemplate';
