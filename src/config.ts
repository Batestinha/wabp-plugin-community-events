import { z } from 'zod';
import type { TranslateFn } from '../../../platform/i18n';
import { eventsMessages } from './messages';

export const EVENT_DATE_QUESTION_TYPE = 'date';
export const EVENT_TIME_QUESTION_TYPE = 'time';
export const EVENT_CHOICE_QUESTION_TYPE = 'choice';
export const EVENT_CREATE_PERMISSION_PREFIX = 'events.create.';
export const EVENT_SUBGROUP_SUGGESTION_CONVERSION_POLICIES = ['off', 'auto_convert'] as const;
export const EVENT_DATE_TEMPLATE_TOKENS = ['weekday', 'dd', 'mm', 'yy', 'yyyy', 'hour', 'minute'] as const;
export const EVENT_PROFILE_TEMPLATE_TOKENS = ['profileId', 'profileLabel', 'creatorDisplayName'] as const;
export const EVENT_GROUP_HINT_TEMPLATE_TOKENS = ['eventId', 'groupDisplayName', 'groupJoinUrl', 'subgroupChatId'] as const;
export const EVENT_EDIT_ANNOUNCEMENT_TEMPLATE_TOKENS = [
  'eventId',
  'groupDisplayName',
  'previousGroupDisplayName',
  'subgroupChatId',
  'editorDisplayName'
] as const;
export const EVENT_CALENDAR_HINT_TEMPLATE_TOKENS = ['eventId', 'groupDisplayName', 'groupJoinUrl', 'subgroupChatId', 'calendarId', 'calendarDisplayName', 'calendarSubscriptionUrl'] as const;
export const EVENT_WEATHER_TEMPLATE_TOKENS = [
  'eventId',
  'groupDisplayName',
  'subgroupChatId',
  'weatherDate',
  'weatherLocation',
  'weatherSummary',
  'temperatureMax',
  'temperatureMin',
  'precipitation',
  'precipitationProbability',
  'windSpeed',
  'windGust',
  'windDirection',
  'weatherCode'
] as const;
export const EVENT_SYSTEM_TEMPLATE_TOKENS = [...new Set<string>([
  ...EVENT_DATE_TEMPLATE_TOKENS,
  ...EVENT_PROFILE_TEMPLATE_TOKENS,
  ...EVENT_GROUP_HINT_TEMPLATE_TOKENS,
  ...EVENT_EDIT_ANNOUNCEMENT_TEMPLATE_TOKENS,
  ...EVENT_CALENDAR_HINT_TEMPLATE_TOKENS,
  ...EVENT_WEATHER_TEMPLATE_TOKENS
])];
export const DEFAULT_EVENT_CALENDAR_ID = 'events';
export const DEFAULT_EVENT_GROUP_HINT_TEMPLATE = eventsMessages[
  'official.community-events.profile.climbing.eventGroupHint.template'
]!;
export const DEFAULT_EVENT_EDIT_ANNOUNCEMENT_TEMPLATE = eventsMessages[
  'official.community-events.profile.climbing.eventEditAnnouncement.template'
]!;
export const DEFAULT_EVENT_CALENDAR_TITLE_TEMPLATE = eventsMessages[
  'official.community-events.profile.climbing.calendar.titleTemplate'
]!;
export const DEFAULT_EVENT_CALENDAR_HINT_TEMPLATE = 'Event created by {creatorDisplayName}. Subscribe to {calendarDisplayName} by tapping this link: {calendarSubscriptionUrl}';
export const DEFAULT_EVENT_WEATHER_TEMPLATE = eventsMessages[
  'official.community-events.profile.climbing.weather.template'
]!;
export const DEFAULT_EVENT_SUBGROUP_SUGGESTION_PRE_FLOW_NOTICE_TEMPLATE = eventsMessages[
  'official.community-events.subgroupSuggestionConversion.preFlowNotice.template'
]!;

const authoredTextSchema = z.string().refine((value) => value.trim().length > 0, 'Required');
const optionalAuthoredTextSchema = z.string().transform((value) => value.trim() ? value : '');
const localTimeSchema = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const eventQuestionChoiceSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  label: z.string().trim().min(1)
}).strict();

const eventQuestionObjectSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  prompt: z.string().trim().min(1),
  type: z.enum(['text', EVENT_DATE_QUESTION_TYPE, EVENT_TIME_QUESTION_TYPE, EVENT_CHOICE_QUESTION_TYPE]).default('text'),
  required: z.boolean().default(true),
  choices: z.array(eventQuestionChoiceSchema).max(24).default([])
}).strict().superRefine((question, ctx) => {
  if (question.type !== EVENT_CHOICE_QUESTION_TYPE && question.choices.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'choices are only allowed for closed questions',
      path: ['choices']
    });
  }
  if (question.type === EVENT_CHOICE_QUESTION_TYPE && question.choices.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'closed questions require at least one answer choice',
      path: ['choices']
    });
  }
  for (const choice of question.choices) {
    if (question.choices.filter((candidate) => candidate.id === choice.id).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'answer choice ids must be unique',
        path: ['choices']
      });
      break;
    }
  }
});

export const eventQuestionSchema = z.preprocess(normalizeEventQuestionInput, eventQuestionObjectSchema);

export const eventPollOptionSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  label: z.string().trim().min(1),
  responseClassId: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
}).strict();

export const eventResponseClassSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  label: z.string().trim().min(1),
  includeInEventGroup: z.boolean().default(false),
  includeInAttendanceCount: z.boolean().default(false)
}).strict();

const eventCalendarDirectorySchema = z.string().trim().min(1).superRefine((directory, ctx) => {
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/.test(directory)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Calendar directory must be relative' });
  }
  if (directory.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Calendar directory cannot contain relative path segments' });
  }
});

const eventCalendarResourceObjectSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  directory: eventCalendarDirectorySchema.default('calendar'),
  subscriptionToken: z.string().trim().default(''),
  publication: z.object({
    enabled: z.boolean().default(false),
    endpointUrl: z.string().trim().url().or(z.literal('')).default(''),
    secretFieldName: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).or(z.literal('')).default('bot_secret'),
    feedId: z.string().trim().regex(/^[a-z][a-z0-9-]*$/).or(z.literal('')).default(''),
    label: z.string().trim().default(''),
    calendarUrl: z.string().trim().url().or(z.literal('')).default('')
  }).strict().default({})
}).strict();

export const eventCalendarResourceSchema = eventCalendarResourceObjectSchema;

export const eventLocationConfigSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('question'),
    questionKey: z.string().trim().min(1)
  }).strict(),
  z.object({
    source: z.literal('fixed'),
    label: z.string().trim().min(1),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timezone: z.string().trim().min(1)
  }).strict()
]).default({
  source: 'question',
  questionKey: 'place'
});

export const eventWeatherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sendOnPollClose: z.boolean().default(true),
  sendDaily: z.boolean().default(false),
  sendAtLocalTime: localTimeSchema.default('07:00'),
  template: authoredTextSchema.default(DEFAULT_EVENT_WEATHER_TEMPLATE)
}).strict().default({});

const eventProfileObjectSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().trim().min(1),
  permissionSuffix: z.string().trim().regex(/^[a-z][a-z0-9-]*$/).optional(),
  allowScopeMemberCreation: z.boolean().default(false),
  announcementGroupWid: z.string().trim().optional().default(''),
  optionalPromptSuffix: z.string().max(500).default(''),
  startsAtDateQuestionKey: z.string().trim().min(1).default('startDate'),
  startsAtTimeQuestionKey: z.string().trim().min(1).default('startTime'),
  location: eventLocationConfigSchema,
  questions: z.array(eventQuestionSchema).min(1),
  poll: z.object({
    titleTemplate: authoredTextSchema,
    responseClasses: z.array(eventResponseClassSchema).min(1).max(12),
    options: z.array(eventPollOptionSchema).min(1).max(12),
    allowMultipleAnswers: z.boolean().default(false),
    closeOffsetHoursBeforeStart: z.number().int().min(0).max(24 * 30).default(8)
  }).strict(),
  group: z.object({
    titleTemplate: authoredTextSchema,
    cleanupOffsetHoursAfterStart: z.number().int().min(0).max(24 * 365).default(48)
  }).strict(),
  eventGroupHint: z.object({
    template: authoredTextSchema.default(DEFAULT_EVENT_GROUP_HINT_TEMPLATE),
    sendForUnplannedEvents: z.boolean().default(true),
    sendForPlannedEvents: z.boolean().default(false),
    sendForAdoptedEvents: z.boolean().default(false)
  }).strict().default({}),
  eventEditAnnouncement: z.object({
    enabled: z.boolean().default(false),
    template: authoredTextSchema.default(DEFAULT_EVENT_EDIT_ANNOUNCEMENT_TEMPLATE)
  }).strict().default({}),
  calendar: z.object({
    calendarId: z.string().trim().regex(/^[a-z][a-z0-9-]*$/).or(z.literal('')).default(DEFAULT_EVENT_CALENDAR_ID),
    durationMinutes: z.number().int().positive().max(24 * 60 * 7).default(240),
    titleTemplate: optionalAuthoredTextSchema.optional(),
    descriptionTemplate: optionalAuthoredTextSchema.optional(),
    hint: z.object({
      sendOnPollPublished: z.boolean().default(false),
      sendOnUnplannedCreated: z.boolean().default(false),
      template: authoredTextSchema.default(DEFAULT_EVENT_CALENDAR_HINT_TEMPLATE)
    }).strict().default({})
  }).strict().default({}),
  weather: eventWeatherConfigSchema
}).strict().superRefine((profile, ctx) => {
  const questionKeys = new Set(profile.questions.map((question) => question.key));
  const systemTemplateTokens = new Set(EVENT_SYSTEM_TEMPLATE_TOKENS);
  for (const [index, question] of profile.questions.entries()) {
    if (systemTemplateTokens.has(question.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `question key ${question.key} is reserved for system template data`,
        path: ['questions', index, 'key']
      });
    }
    if (profile.questions.filter((candidate) => candidate.key === question.key).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `question keys must be unique`,
        path: ['questions']
      });
      break;
    }
  }
  for (const responseClass of profile.poll.responseClasses) {
    if (profile.poll.responseClasses.filter((candidate) => candidate.id === responseClass.id).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `response class ids must be unique`,
        path: ['poll', 'responseClasses']
      });
      break;
    }
  }
  const responseClassIds = new Set(profile.poll.responseClasses.map((responseClass) => responseClass.id));
  for (const option of profile.poll.options) {
    if (profile.poll.options.filter((candidate) => candidate.id === option.id).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `poll option ids must be unique`,
        path: ['poll', 'options']
      });
      break;
    }
    if (!responseClassIds.has(option.responseClassId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `poll option responseClassId must reference a response class`,
        path: ['poll', 'options']
      });
    }
  }
  if (!questionKeys.has(profile.startsAtDateQuestionKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `startsAtDateQuestionKey must reference a question key`,
      path: ['startsAtDateQuestionKey']
    });
  }
  if (!questionKeys.has(profile.startsAtTimeQuestionKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `startsAtTimeQuestionKey must reference a question key`,
      path: ['startsAtTimeQuestionKey']
    });
  }
  const startsAtDate = profile.questions.find((question) => question.key === profile.startsAtDateQuestionKey);
  if (startsAtDate?.type !== EVENT_DATE_QUESTION_TYPE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `startsAtDateQuestionKey must reference a date question`,
      path: ['startsAtDateQuestionKey']
    });
  }
  const startsAtTime = profile.questions.find((question) => question.key === profile.startsAtTimeQuestionKey);
  if (startsAtTime?.type !== EVENT_TIME_QUESTION_TYPE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `startsAtTimeQuestionKey must reference a time question`,
      path: ['startsAtTimeQuestionKey']
    });
  }
  if (profile.location.source === 'question' && !questionKeys.has(profile.location.questionKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `location.questionKey must reference a question key`,
      path: ['location', 'questionKey']
    });
  }
  const locationQuestionKey = profile.location.source === 'question'
    ? profile.location.questionKey
    : undefined;
  const locationQuestion = locationQuestionKey
    ? profile.questions.find((question) => question.key === locationQuestionKey)
    : undefined;
  if (locationQuestion && locationQuestion.type !== 'text' && locationQuestion.type !== 'choice') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `location.questionKey must reference a text or choice question`,
      path: ['location', 'questionKey']
    });
  }
  if (profile.weather.enabled && !profile.weather.sendOnPollClose && !profile.weather.sendDaily) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `weather requires at least one send trigger`,
      path: ['weather']
    });
  }
  const templateTokens = new Set([
    ...questionKeys,
    ...EVENT_DATE_TEMPLATE_TOKENS,
    ...EVENT_PROFILE_TEMPLATE_TOKENS
  ]);
  const groupHintTemplateTokens = new Set([
    ...templateTokens,
    ...EVENT_GROUP_HINT_TEMPLATE_TOKENS
  ]);
  const editAnnouncementTemplateTokens = new Set([
    ...templateTokens,
    ...EVENT_EDIT_ANNOUNCEMENT_TEMPLATE_TOKENS
  ]);
  const calendarHintTemplateTokens = new Set([
    ...templateTokens,
    ...EVENT_CALENDAR_HINT_TEMPLATE_TOKENS
  ]);
  const weatherTemplateTokens = new Set([
    ...templateTokens,
    ...EVENT_WEATHER_TEMPLATE_TOKENS
  ]);
  validateEventTemplate(profile.poll.titleTemplate, templateTokens, ['poll', 'titleTemplate'], ctx);
  validateEventTemplate(profile.group.titleTemplate, templateTokens, ['group', 'titleTemplate'], ctx);
  validateEventTemplate(profile.eventGroupHint.template, groupHintTemplateTokens, ['eventGroupHint', 'template'], ctx);
  validateEventTemplate(
    profile.eventEditAnnouncement.template,
    editAnnouncementTemplateTokens,
    ['eventEditAnnouncement', 'template'],
    ctx
  );
  if (profile.calendar.titleTemplate) {
    validateEventTemplate(profile.calendar.titleTemplate, templateTokens, ['calendar', 'titleTemplate'], ctx);
  }
  if (profile.calendar.descriptionTemplate) {
    validateEventTemplate(profile.calendar.descriptionTemplate, templateTokens, ['calendar', 'descriptionTemplate'], ctx);
  }
  validateEventTemplate(profile.calendar.hint.template, calendarHintTemplateTokens, ['calendar', 'hint', 'template'], ctx);
  validateEventTemplate(profile.weather.template, weatherTemplateTokens, ['weather', 'template'], ctx);
});

export const eventProfileSchema = z.preprocess(normalizeEventProfileInput, eventProfileObjectSchema);

export const defaultClimbingEventProfile: EventProfile = {
  id: 'climbing',
  label: 'Climbing',
  permissionSuffix: 'climbing',
  allowScopeMemberCreation: false,
  announcementGroupWid: '',
  optionalPromptSuffix: 'Reply with any symbol, such as -, to skip.',
  startsAtDateQuestionKey: 'startDate',
  startsAtTimeQuestionKey: 'startTime',
  location: {
    source: 'question',
    questionKey: 'place'
  },
  questions: [
    { key: 'place', prompt: 'Where', type: 'text', required: true, choices: [] },
    { key: 'startDate', prompt: 'Date', type: 'date', required: true, choices: [] },
    { key: 'startTime', prompt: 'Time', type: 'time', required: true, choices: [] },
    { key: 'style', prompt: 'Climbing style', type: 'text', required: true, choices: [] }
  ],
  poll: {
    titleTemplate: '{style} in {place}: {weekday}, {dd}-{mm}-{yy} By: {creatorDisplayName}',
    responseClasses: [
      {
        id: 'event_group_member',
        label: 'Event group member',
        includeInEventGroup: true,
        includeInAttendanceCount: true
      }
    ],
    options: [
      { id: 'going', label: "I'm going ✅", responseClassId: 'event_group_member' },
      { id: 'ride', label: "I want to go, but I'll need a ride 🚗", responseClassId: 'event_group_member' }
    ],
    allowMultipleAnswers: false,
    closeOffsetHoursBeforeStart: 8
  },
  group: {
    titleTemplate: '{style} in {place}: {weekday}, {dd}-{mm}-{yy}',
    cleanupOffsetHoursAfterStart: 48
  },
  eventGroupHint: {
    template: DEFAULT_EVENT_GROUP_HINT_TEMPLATE,
    sendForUnplannedEvents: true,
    sendForPlannedEvents: false,
    sendForAdoptedEvents: false
  },
  eventEditAnnouncement: {
    enabled: false,
    template: DEFAULT_EVENT_EDIT_ANNOUNCEMENT_TEMPLATE
  },
  calendar: {
    calendarId: DEFAULT_EVENT_CALENDAR_ID,
    durationMinutes: 240,
    titleTemplate: DEFAULT_EVENT_CALENDAR_TITLE_TEMPLATE,
    hint: {
      sendOnPollPublished: false,
      sendOnUnplannedCreated: false,
      template: DEFAULT_EVENT_CALENDAR_HINT_TEMPLATE
    }
  },
  weather: {
    enabled: false,
    sendOnPollClose: true,
    sendDaily: false,
    sendAtLocalTime: '07:00',
    template: DEFAULT_EVENT_WEATHER_TEMPLATE
  }
};

export const defaultEventsCalendarResource: EventCalendarResource = {
  id: DEFAULT_EVENT_CALENDAR_ID,
  label: 'Events',
  enabled: true,
  directory: 'calendar',
  subscriptionToken: '',
  publication: {
    enabled: false,
    endpointUrl: '',
    secretFieldName: 'bot_secret',
    feedId: '',
    label: '',
    calendarUrl: ''
  }
};

const eventSubgroupSuggestionPreFlowNoticeTemplateSchema = z.string()
  .max(1000)
  .refine((value) => value.trim().length > 0, 'Required')
  .refine(
    (value) => !/\{(?:suggested[-_]?title|title)\}/i.test(value),
    'Suggested subgroup titles are not available to the notice template'
  );

export const eventSubgroupSuggestionPreFlowNoticeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  template: eventSubgroupSuggestionPreFlowNoticeTemplateSchema.default(
    DEFAULT_EVENT_SUBGROUP_SUGGESTION_PRE_FLOW_NOTICE_TEMPLATE
  )
}).strict().default({});

export const eventSubgroupSuggestionConversionConfigSchema = z.object({
  policy: z.enum(EVENT_SUBGROUP_SUGGESTION_CONVERSION_POLICIES).default('off'),
  preFlowNotice: eventSubgroupSuggestionPreFlowNoticeConfigSchema
}).strict().default({});

const eventsConfigObjectSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().trim().min(1).default('UTC'),
  subgroupSuggestionConversion: eventSubgroupSuggestionConversionConfigSchema,
  cleanup: z.object({
    retryDelaysMinutes: z.array(z.number().int().positive().max(24 * 60 * 30)).max(12).default([15, 60, 360, 1440]),
    lastFailureMessage: z.string().trim().default(''),
    lastFailureAt: z.string().trim().default('')
  }).strict().default({}),
  adoption: z.object({}).strict().default({}),
  calendars: z.array(eventCalendarResourceSchema).min(1).default([defaultEventsCalendarResource]),
  eventProfiles: z.array(eventProfileSchema).min(1).default([defaultClimbingEventProfile])
}).strict().superRefine((config, ctx) => {
  const calendarIds = new Set<string>();
  const publicationTargets = new Set<string>();
  config.calendars.forEach((calendar, index) => {
    if (calendarIds.has(calendar.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'calendar ids must be unique',
        path: ['calendars', index, 'id']
      });
    } else {
      calendarIds.add(calendar.id);
    }

    if (!calendar.publication.enabled) {
      return;
    }
    const endpointUrl = normalizedCalendarPublicationEndpoint(calendar.publication.endpointUrl);
    const feedId = calendar.publication.feedId || calendar.id;
    const targetKey = JSON.stringify([endpointUrl, feedId]);
    if (publicationTargets.has(targetKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enabled calendar publication targets must be unique per endpoint and feed id',
        path: ['calendars', index, 'publication', 'feedId']
      });
    } else {
      publicationTargets.add(targetKey);
    }
  });
  config.eventProfiles.forEach((profile, index) => {
    const calendarId = profile.calendar.calendarId.trim();
    if (calendarId && !calendarIds.has(calendarId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'calendar.calendarId must reference a configured calendar',
        path: ['eventProfiles', index, 'calendar', 'calendarId']
      });
    }
  });
});

function normalizedCalendarPublicationEndpoint(endpointUrl: string): string {
  if (!endpointUrl) {
    return '';
  }
  return new URL(endpointUrl).toString();
}

export const eventsConfigSchema = z.preprocess(normalizeEventsConfigInput, eventsConfigObjectSchema);

export type EventQuestion = z.infer<typeof eventQuestionSchema>;
export type EventQuestionChoice = z.infer<typeof eventQuestionChoiceSchema>;
export type EventPollOption = z.infer<typeof eventPollOptionSchema>;
export type EventResponseClass = z.infer<typeof eventResponseClassSchema>;
export type EventCalendarResource = z.infer<typeof eventCalendarResourceSchema>;
export type EventLocationConfig = z.infer<typeof eventLocationConfigSchema>;
export type EventWeatherConfig = z.infer<typeof eventWeatherConfigSchema>;
export type EventProfile = z.infer<typeof eventProfileSchema>;
export type EventSubgroupSuggestionPreFlowNoticeConfig = z.infer<typeof eventSubgroupSuggestionPreFlowNoticeConfigSchema>;
export type EventSubgroupSuggestionConversionConfig = z.infer<typeof eventSubgroupSuggestionConversionConfigSchema>;
export type EventsConfig = z.infer<typeof eventsConfigSchema>;

export function parseEventsConfig(input: unknown): EventsConfig {
  return eventsConfigSchema.parse(input);
}

export function localizeSubgroupSuggestionPreFlowNotice(
  notice: EventSubgroupSuggestionPreFlowNoticeConfig,
  t: TranslateFn
): EventSubgroupSuggestionPreFlowNoticeConfig {
  return {
    ...notice,
    template: localizeIfDefault(
      notice.template,
      DEFAULT_EVENT_SUBGROUP_SUGGESTION_PRE_FLOW_NOTICE_TEMPLATE,
      () => t('official.community-events.subgroupSuggestionConversion.preFlowNotice.template')
    )
  };
}

export function localizeDefaultEventProfiles(profiles: EventProfile[], t: TranslateFn): EventProfile[] {
  return profiles.map((profile) => isDefaultClimbingEventProfile(profile)
    ? localizedDefaultClimbingEventProfile(profile, t)
    : profile);
}

export function eventProfilePermission(profile: EventProfile): string {
  return `${EVENT_CREATE_PERMISSION_PREFIX}${profile.permissionSuffix?.trim() || profile.id}`;
}

function localizedDefaultClimbingEventProfile(profile: EventProfile, t: TranslateFn): EventProfile {
  return {
    ...profile,
    label: localizeIfDefault(profile.label, defaultClimbingEventProfile.label, () => t('official.community-events.profile.climbing.label')),
    optionalPromptSuffix: localizeIfDefault(
      profile.optionalPromptSuffix,
      defaultClimbingEventProfile.optionalPromptSuffix,
      () => t('official.community-events.flow.optionalPromptSuffix')
    ),
    questions: profile.questions.map((question) => ({
      ...question,
      prompt: localizeIfDefault(
        question.prompt,
        defaultQuestionByKey(question.key)?.prompt,
        () => t(`official.community-events.profile.climbing.question.${question.key}`)
      )
    })),
    poll: {
      ...profile.poll,
      titleTemplate: localizeIfDefault(
        profile.poll.titleTemplate,
        defaultClimbingEventProfile.poll.titleTemplate,
        () => t('official.community-events.profile.climbing.poll.titleTemplate')
      ),
      responseClasses: profile.poll.responseClasses.map((responseClass) => ({
        ...responseClass,
        label: localizeIfDefault(
          responseClass.label,
          defaultResponseClassById(responseClass.id)?.label,
          () => t(`official.community-events.profile.climbing.responseClass.${responseClass.id}`)
        )
      })),
      options: profile.poll.options.map((option) => ({
        ...option,
        label: localizeIfDefault(
          option.label,
          defaultPollOptionById(option.id)?.label,
          () => t(`official.community-events.profile.climbing.poll.option.${option.id}`)
        )
      }))
    },
    group: {
      ...profile.group,
      titleTemplate: localizeIfDefault(
        profile.group.titleTemplate,
        defaultClimbingEventProfile.group.titleTemplate,
        () => t('official.community-events.profile.climbing.group.titleTemplate')
      )
    },
    eventGroupHint: {
      ...profile.eventGroupHint,
      template: localizeIfDefault(
        profile.eventGroupHint.template,
        defaultClimbingEventProfile.eventGroupHint.template,
        () => t('official.community-events.profile.climbing.eventGroupHint.template')
      )
    },
    eventEditAnnouncement: {
      ...profile.eventEditAnnouncement,
      template: localizeIfDefault(
        profile.eventEditAnnouncement.template,
        defaultClimbingEventProfile.eventEditAnnouncement.template,
        () => t('official.community-events.profile.climbing.eventEditAnnouncement.template')
      )
    },
    calendar: {
      ...profile.calendar,
      titleTemplate: localizeIfDefault(
        profile.calendar.titleTemplate ?? DEFAULT_EVENT_CALENDAR_TITLE_TEMPLATE,
        DEFAULT_EVENT_CALENDAR_TITLE_TEMPLATE,
        () => t('official.community-events.profile.climbing.calendar.titleTemplate')
      ),
      hint: {
        ...profile.calendar.hint,
        template: localizeIfDefault(
          profile.calendar.hint.template,
          defaultClimbingEventProfile.calendar.hint.template,
          () => t('official.community-events.profile.climbing.calendar.hint.template')
        )
      }
    },
    weather: {
      ...profile.weather,
      template: localizeIfDefault(
        profile.weather.template,
        defaultClimbingEventProfile.weather.template,
        () => t('official.community-events.profile.climbing.weather.template')
      )
    }
  };
}

function isDefaultClimbingEventProfile(profile: EventProfile): boolean {
  if (profile.id !== defaultClimbingEventProfile.id) {
    return false;
  }
  const questionTypes = new Map(profile.questions.map((question) => [question.key, question.type]));
  for (const question of defaultClimbingEventProfile.questions) {
    if (questionTypes.get(question.key) !== question.type) {
      return false;
    }
  }
  const responseClassIds = new Set(profile.poll.responseClasses.map((responseClass) => responseClass.id));
  for (const responseClass of defaultClimbingEventProfile.poll.responseClasses) {
    if (!responseClassIds.has(responseClass.id)) {
      return false;
    }
  }
  const optionResponseClasses = new Map(profile.poll.options.map((option) => [option.id, option.responseClassId]));
  for (const option of defaultClimbingEventProfile.poll.options) {
    if (optionResponseClasses.get(option.id) !== option.responseClassId) {
      return false;
    }
  }
  return true;
}

function localizeIfDefault(current: string, defaultValue: string | undefined, localizedValue: () => string): string {
  return defaultValue !== undefined && current === defaultValue ? localizedValue() : current;
}

function defaultQuestionByKey(key: string): EventQuestion | undefined {
  return defaultClimbingEventProfile.questions.find((question) => question.key === key);
}

function defaultResponseClassById(id: string): EventResponseClass | undefined {
  return defaultClimbingEventProfile.poll.responseClasses.find((responseClass) => responseClass.id === id);
}

function defaultPollOptionById(id: string): EventPollOption | undefined {
  return defaultClimbingEventProfile.poll.options.find((option) => option.id === id);
}

function normalizeEventsConfigInput(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (!Array.isArray(input.eventProfiles)) {
    return input;
  }
  return {
    ...input,
    eventProfiles: input.eventProfiles.map((profile) => normalizeEventProfileInput(profile))
  };
}

function normalizeEventProfileInput(profile: unknown): unknown {
  if (!isRecord(profile) || !isRecord(profile.poll)) {
    return profile;
  }
  const permissionSuffix = legacyPermissionSuffix(profile.permission, profile.permissionSuffix, profile.id);
  const {
    permission: _legacyPermission,
    startsAtQuestionKey: legacyStartsAtQuestionKey,
    unplanned: previousEventGroupHint,
    ...profileWithoutLegacyFields
  } = profile;
  const normalizedStartQuestions = normalizeEventProfileStartQuestions(profile, legacyStartsAtQuestionKey);
  const normalizedProfile = {
    ...profileWithoutLegacyFields,
    ...normalizedStartQuestions.keys,
    eventGroupHint: normalizeEventGroupHintInput(profile.eventGroupHint, previousEventGroupHint)
  };
  const rawResponseClasses = Array.isArray(profile.poll.responseClasses)
    ? profile.poll.responseClasses.filter(isRecord)
    : [];
  const rawOptions = Array.isArray(profile.poll.options)
    ? profile.poll.options
    : [];
  const responseClasses = rawResponseClasses.map((responseClass) => ({ ...responseClass }));
  const responseClassIds = new Set(responseClasses.map((responseClass) => String(responseClass.id ?? '')).filter(Boolean));
  const options = rawOptions.map((option) => {
    if (!isRecord(option)) {
      return option;
    }
    const hasResponseClassId = typeof option.responseClassId === 'string' && option.responseClassId.trim();
    const legacyCountsAsAttendee = option.countsAsAttendee === true;
    const responseClassId = hasResponseClassId
      ? String(option.responseClassId).trim()
      : legacyResponseClassId(legacyCountsAsAttendee, responseClasses);
    if (!hasResponseClassId && responseClassId && !responseClassIds.has(responseClassId)) {
      responseClasses.push(legacyResponseClass(responseClassId, legacyCountsAsAttendee));
      responseClassIds.add(responseClassId);
    }
    const { countsAsAttendee: _removed, ...nextOption } = option;
    return {
      ...nextOption,
      ...(responseClassId ? { responseClassId } : {})
    };
  });
  return {
    ...normalizedProfile,
    ...(permissionSuffix ? { permissionSuffix } : {}),
    questions: normalizedStartQuestions.questions,
    poll: {
      ...profile.poll,
      responseClasses,
      options
    }
  };
}

function normalizeEventGroupHintInput(currentInput: unknown, previousInput: unknown): unknown {
  const current = isRecord(currentInput) ? currentInput : {};
  const previous = isRecord(previousInput) ? previousInput : {};
  const currentTemplate = typeof current.template === 'string'
    ? current.template
    : undefined;
  const previousTemplate = typeof previous.announcementTemplate === 'string'
    ? previous.announcementTemplate
    : undefined;
  const {
    announcementTemplate: _currentAnnouncementTemplate,
    ...currentWithoutOldTemplate
  } = current;
  const {
    announcementTemplate: _previousAnnouncementTemplate,
    ...previousWithoutOldTemplate
  } = previous;
  const normalizedTemplate = currentTemplate ?? previousTemplate;
  return {
    ...previousWithoutOldTemplate,
    ...currentWithoutOldTemplate,
    ...(normalizedTemplate !== undefined ? { template: normalizedTemplate } : {})
  };
}

function normalizeEventProfileStartQuestions(
  profile: Record<string, unknown>,
  legacyStartsAtQuestionKey: unknown
): { questions: unknown; keys: Record<string, string> } {
  if (!Array.isArray(profile.questions)) {
    return { questions: profile.questions, keys: {} };
  }

  const questions = profile.questions.map((question) => normalizeEventQuestionInput(question));
  const legacyKey = trimmedString(legacyStartsAtQuestionKey);
  if (!legacyKey) {
    return { questions, keys: {} };
  }

  const questionRecords = questions.filter(isRecord);
  const explicitDateKey = trimmedString(profile.startsAtDateQuestionKey);
  const explicitTimeKey = trimmedString(profile.startsAtTimeQuestionKey);
  const dateKey = explicitDateKey || firstQuestionKeyOfType(questionRecords, EVENT_DATE_QUESTION_TYPE) || uniqueQuestionKey(questionRecords, 'startDate');
  const timeKey = explicitTimeKey || firstQuestionKeyOfType(questionRecords, EVENT_TIME_QUESTION_TYPE) || uniqueQuestionKey(questionRecords, 'startTime');
  const hasDateQuestion = questionRecords.some((question) => question.key === dateKey && question.type === EVENT_DATE_QUESTION_TYPE);
  const hasTimeQuestion = questionRecords.some((question) => question.key === timeKey && question.type === EVENT_TIME_QUESTION_TYPE);
  const legacyQuestion = questionRecords.find((question) => question.key === legacyKey);
  const keepLegacyQuestion = Boolean(
    legacyQuestion &&
    (legacyQuestion.type === EVENT_DATE_QUESTION_TYPE || legacyQuestion.type === EVENT_TIME_QUESTION_TYPE)
  );

  const additions = [
    !hasDateQuestion ? splitStartsAtQuestion(legacyQuestion, dateKey, EVENT_DATE_QUESTION_TYPE) : null,
    !hasTimeQuestion ? splitStartsAtQuestion(legacyQuestion, timeKey, EVENT_TIME_QUESTION_TYPE) : null
  ].filter(Boolean);

  let inserted = false;
  const nextQuestions = questions.flatMap((question) => {
    if (!isRecord(question) || question.key !== legacyKey) {
      return [question];
    }
    inserted = true;
    return keepLegacyQuestion ? [question, ...additions] : additions;
  });
  if (!inserted) {
    nextQuestions.push(...additions);
  }

  return {
    questions: nextQuestions,
    keys: {
      ...(explicitDateKey ? {} : { startsAtDateQuestionKey: dateKey }),
      ...(explicitTimeKey ? {} : { startsAtTimeQuestionKey: timeKey })
    }
  };
}

function splitStartsAtQuestion(
  legacyQuestion: Record<string, unknown> | undefined,
  key: string,
  type: typeof EVENT_DATE_QUESTION_TYPE | typeof EVENT_TIME_QUESTION_TYPE
): Record<string, unknown> {
  return {
    key,
    prompt: splitStartsAtPrompt(trimmedString(legacyQuestion?.prompt), type),
    type,
    required: typeof legacyQuestion?.required === 'boolean' ? legacyQuestion.required : true,
    choices: []
  };
}

function splitStartsAtPrompt(
  prompt: string | undefined,
  type: typeof EVENT_DATE_QUESTION_TYPE | typeof EVENT_TIME_QUESTION_TYPE
): string {
  if (!prompt || prompt.toLowerCase() === 'when') {
    return type === EVENT_DATE_QUESTION_TYPE ? 'Date' : 'Time';
  }
  return `${prompt} ${type === EVENT_DATE_QUESTION_TYPE ? 'date' : 'time'}`;
}

function firstQuestionKeyOfType(questions: Array<Record<string, unknown>>, type: string): string | undefined {
  const question = questions.find((candidate) => candidate.type === type);
  return trimmedString(question?.key);
}

function uniqueQuestionKey(questions: Array<Record<string, unknown>>, preferred: string): string {
  const keys = new Set(questions.map((question) => trimmedString(question.key)).filter(Boolean));
  if (!keys.has(preferred)) {
    return preferred;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${preferred}${index}`;
    if (!keys.has(candidate)) {
      return candidate;
    }
  }
  return `${preferred}1000`;
}

function normalizeEventQuestionInput(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const type = input.type === EVENT_CHOICE_QUESTION_TYPE
    ? EVENT_CHOICE_QUESTION_TYPE
    : input.type === EVENT_DATE_QUESTION_TYPE
      ? EVENT_DATE_QUESTION_TYPE
      : input.type === EVENT_TIME_QUESTION_TYPE
        ? EVENT_TIME_QUESTION_TYPE
      : 'text';
  return {
    ...input,
    type,
    choices: type === EVENT_CHOICE_QUESTION_TYPE ? input.choices : []
  };
}

function legacyPermissionSuffix(permission: unknown, permissionSuffix: unknown, profileId: unknown): string | undefined {
  if (typeof permissionSuffix === 'string' && permissionSuffix.trim()) {
    return permissionSuffix.trim();
  }
  if (typeof permission === 'string' && permission.trim().startsWith(EVENT_CREATE_PERMISSION_PREFIX)) {
    return permission.trim().slice(EVENT_CREATE_PERMISSION_PREFIX.length);
  }
  if (typeof profileId === 'string' && profileId.trim()) {
    return profileId.trim();
  }
  return undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function legacyResponseClassId(countsAsAttendee: boolean, responseClasses: Array<Record<string, unknown>>): string {
  const matching = responseClasses.find((responseClass) =>
    Boolean(responseClass.includeInAttendanceCount) === countsAsAttendee ||
    Boolean(responseClass.includeInEventGroup) === countsAsAttendee
  );
  if (typeof matching?.id === 'string' && matching.id.trim()) {
    return matching.id.trim();
  }
  return countsAsAttendee ? 'event_group_member' : 'non_event_group_member';
}

function legacyResponseClass(id: string, countsAsAttendee: boolean): Record<string, unknown> {
  return {
    id,
    label: id === 'event_group_member'
      ? 'Event group member'
      : id === 'non_event_group_member'
        ? 'Non event group member'
        : id,
    includeInEventGroup: countsAsAttendee,
    includeInAttendanceCount: countsAsAttendee
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateEventTemplate(
  template: string,
  allowedTokens: Set<string>,
  path: Array<string | number>,
  ctx: z.RefinementCtx
): void {
  for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g)) {
    const token = match[1] ?? '';
    if (!allowedTokens.has(token)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown template variable {${token}}`,
        path
      });
    }
  }
}
