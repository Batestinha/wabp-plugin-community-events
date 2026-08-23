export {
  ConditionalTemplateSyntaxError as EventTemplateSyntaxError,
  parseConditionalTemplate as parseEventTemplate,
  renameConditionalTemplateToken as renameEventTemplateToken,
  renderConditionalTemplate as renderEventTemplateText,
  validateConditionalTemplate as validateEventTemplateText
} from '../../../platform/templates/conditionalTemplate';

export type {
  ConditionalTemplateNode as EventTemplateNode,
  ConditionalTemplateValidationIssue as EventTemplateValidationIssue
} from '../../../platform/templates/conditionalTemplate';
