import { dateSpanTemplateValues } from '@wabs/plugin-sdk/date-template';
import type { EventSpanKind } from './span';
export {
  dateTemplateTokens as eventDateTemplateTokens,
  formatTemplateDate as formatEventTemplateDate,
  formatTemplateDateTime as formatEventDateTime
} from '@wabs/plugin-sdk/date-template';

export function eventSpanTemplateValues(input: {
  startsAt: Date;
  endsAt?: Date | undefined;
  spanKind?: EventSpanKind | undefined;
  timezone: string;
  locale?: string | undefined;
}): Record<string, string> {
  return dateSpanTemplateValues({ ...input, multiDay: input.spanKind === 'multi_day' });
}
