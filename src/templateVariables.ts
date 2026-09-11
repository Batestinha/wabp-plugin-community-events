export const EVENT_SPAN_TEMPLATE_VARIABLES = [
  { token: 'spanKind', label: 'Event duration type' },
  { token: 'endsAt', label: 'End date and time' },
  { token: 'endDate', label: 'End date' },
  { token: 'endTime', label: 'End time' },
  { token: 'endWeekday', label: 'End weekday' },
  { token: 'endDd', label: 'End day' },
  { token: 'endMm', label: 'End month' },
  { token: 'endYy', label: 'End 2-digit year' },
  { token: 'endYyyy', label: 'End year' },
  { token: 'endHour', label: 'End hour' },
  { token: 'endMinute', label: 'End minute' }
];

export const EVENT_SPAN_CONDITION_VARIABLES = [
  { token: 'isMultiDay', label: 'More than one day', sampleValue: 'true' }
];

export const EVENT_SPAN_TEMPLATE_TOKENS = [
  ...EVENT_SPAN_TEMPLATE_VARIABLES,
  ...EVENT_SPAN_CONDITION_VARIABLES
].map((variable) => variable.token);
