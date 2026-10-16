// Explicit, complete placements: the platform never infers message locations from keys.
export const eventTextDefinitions = [
  {
    "key": "official.community-events.workflow.edit.title",
    "label": "Workflow / edit / title",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 0,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.edit.description",
    "label": "Workflow / edit / description",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 10,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.cancel.title",
    "label": "Workflow / cancel / title",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 20,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.cancel.description",
    "label": "Workflow / cancel / description",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 30,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.edit.summary",
    "label": "Workflow / edit / summary",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 40,
    "variables": [
      "changes",
      "event",
      "timezone"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.cancel.summary",
    "label": "Workflow / cancel / summary",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 50,
    "variables": [
      "calendar",
      "event",
      "messages"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.deleteMessages",
    "label": "Workflow / delete messages",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 60,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.keepMessages",
    "label": "Workflow / keep messages",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 70,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.unavailable",
    "label": "Workflow / unavailable",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 80,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.noChanges",
    "label": "Workflow / no changes",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 90,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.invalidInput",
    "label": "Workflow / invalid input",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 100,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.locationRequired",
    "label": "Workflow / location required",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 110,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.fixedLocation",
    "label": "Workflow / fixed location",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 120,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.conflict",
    "label": "Workflow / conflict",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 130,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.cancelled",
    "label": "Workflow / cancelled",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 140,
    "variables": [
      "event"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.applied",
    "label": "Workflow / applied",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 150,
    "variables": [
      "event"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.pending",
    "label": "Workflow / pending",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 160,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.cleanupReview",
    "label": "Workflow / cleanup review",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 170,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.workflow.span",
    "label": "Workflow / span",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 180,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.end",
    "label": "Workflow / end",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 190,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.location",
    "label": "Workflow / location",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 200,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.workflow.allowCompletion",
    "label": "Workflow / allow completion",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 210,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.description",
    "label": "Description",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 220,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.disabled",
    "label": "Disabled",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 230,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "general",
      "groupLabel": "Access and general replies"
    }
  },
  {
    "key": "official.community-events.notConfigured",
    "label": "Not configured",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 240,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "general",
      "groupLabel": "Access and general replies"
    }
  },
  {
    "key": "official.community-events.startedPrivate",
    "label": "Started private",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 250,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.startedInGroupFallback",
    "label": "Started in group fallback",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 260,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.started",
    "label": "Started",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 270,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.privateStartFailed",
    "label": "Private start failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 280,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.startFailed",
    "label": "Start failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 290,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.cancelled",
    "label": "Cancelled",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 300,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.invalid",
    "label": "Invalid",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 310,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "general",
      "groupLabel": "Access and general replies"
    }
  },
  {
    "key": "official.community-events.permissionDenied",
    "label": "Permission denied",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 320,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "general",
      "groupLabel": "Access and general replies"
    }
  },
  {
    "key": "official.community-events.subgroupSuggestionConversion.policy.off",
    "label": "Subgroup suggestion conversion / policy / off",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 330,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "controlId": "plugin.official.community-events.subgroupSuggestionConversion.policy",
      "groupId": "suggestions",
      "groupLabel": "Suggestion conversion replies"
    }
  },
  {
    "key": "official.community-events.subgroupSuggestionConversion.policy.auto_convert",
    "label": "Subgroup suggestion conversion / policy / auto_convert",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 340,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "controlId": "plugin.official.community-events.subgroupSuggestionConversion.policy",
      "groupId": "suggestions",
      "groupLabel": "Suggestion conversion replies"
    }
  },
  {
    "key": "official.community-events.subgroupSuggestionConversion.preFlowNotice.template",
    "label": "Subgroup suggestion conversion / pre flow notice / template",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 350,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "controlId": "plugin.official.community-events.subgroupSuggestionConversion.policy",
      "groupId": "suggestions",
      "groupLabel": "Suggestion conversion replies"
    }
  },
  {
    "key": "official.community-events.location.select",
    "label": "Location / select",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 360,
    "variables": [
      "displayPlace",
      "searchQuery"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.freeText",
    "label": "Location / free text",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 370,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.noResults",
    "label": "Location / no results",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 380,
    "variables": [
      "searchQuery"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.timezoneUnavailable",
    "label": "Location / timezone unavailable",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 390,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.missing",
    "label": "Location / missing",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 400,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.failed",
    "label": "Location / failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 410,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.promptFailed",
    "label": "Location / prompt failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 420,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.invalid",
    "label": "Location / invalid",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 430,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.location.wrongRequester",
    "label": "Location / wrong requester",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 440,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "location",
      "groupId": "location",
      "groupLabel": "Location replies"
    }
  },
  {
    "key": "official.community-events.pollPublished",
    "label": "Poll published",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 450,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollLifecycleQueued",
    "label": "Poll lifecycle queued",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 460,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.unplannedPublished",
    "label": "Unplanned published",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 470,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedFinalizationPending",
    "label": "Unplanned finalization pending",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 480,
    "variables": [
      "eventId"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedStillWorkingCreate",
    "label": "Unplanned still working create",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 490,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedStillWorkingSetup",
    "label": "Unplanned still working setup",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 500,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedStillWorkingLink",
    "label": "Unplanned still working link",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 510,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedStillWorkingAnnouncement",
    "label": "Unplanned still working announcement",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 520,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedProvisioningPending",
    "label": "Unplanned provisioning pending",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 530,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedProvisioningOperatorRequired",
    "label": "Unplanned provisioning operator required",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 540,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.unplannedProvisioningRecovered",
    "label": "Unplanned provisioning recovered",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 550,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.provisioningTerminal.attemptsExhausted",
    "label": "Provisioning terminal / attempts exhausted",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 560,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.provisioningTerminal.cleanupExpired",
    "label": "Provisioning terminal / cleanup expired",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 570,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.nativeInvite.sentWithJoinLink",
    "label": "Creator membership paused / native invite / sent with join link",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 580,
    "variables": [
      "eventId",
      "groupJoinUrl",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.nativeInvite.sent",
    "label": "Creator membership paused / native invite / sent",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 590,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.privacyRestriction.joinLink",
    "label": "Creator membership paused / privacy restriction / join link",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 600,
    "variables": [
      "eventId",
      "groupJoinUrl",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.privacyInviteDeliveryUncertain.joinLink",
    "label": "Creator membership paused / privacy invite delivery uncertain / join link",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 610,
    "variables": [
      "eventId",
      "groupJoinUrl",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.providerRejection.joinLink",
    "label": "Creator membership paused / provider rejection / join link",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 620,
    "variables": [
      "eventId",
      "groupJoinUrl",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.outcomeAmbiguous.joinLink",
    "label": "Creator membership paused / outcome ambiguous / join link",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 630,
    "variables": [
      "eventId",
      "groupJoinUrl",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.creatorMembershipPaused.directAddNotObserved.joinLink",
    "label": "Creator membership paused / direct add not observed / join link",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 640,
    "variables": [
      "eventId",
      "groupJoinUrl",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "group",
      "groupId": "group",
      "groupLabel": "Event group invitation replies"
    }
  },
  {
    "key": "official.community-events.publishFailed",
    "label": "Publish failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 650,
    "variables": [
      "reason"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.templateConfigurationInvalid",
    "label": "Template configuration invalid",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 660,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "general",
      "groupLabel": "Access and general replies"
    }
  },
  {
    "key": "official.community-events.unplannedPublishFailed",
    "label": "Unplanned publish failed",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 670,
    "variables": [
      "reason"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "provisioning",
      "groupLabel": "Publication and recovery replies"
    }
  },
  {
    "key": "official.community-events.status",
    "label": "Status",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 680,
    "variables": [
      "enabled",
      "profiles",
      "timezone"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.none",
    "label": "None",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 690,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "general",
      "groupLabel": "Access and general replies"
    }
  },
  {
    "key": "official.community-events.usage",
    "label": "Usage",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 700,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.list.none",
    "label": "List / none",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 710,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.list.item",
    "label": "List / item",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 720,
    "variables": [
      "eventId",
      "range",
      "status",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.list.dayTrips",
    "label": "List / day trips",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 730,
    "variables": [
      "events"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.list.multiDay",
    "label": "List / multi day",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 740,
    "variables": [
      "events"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.list.result",
    "label": "List / result",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 750,
    "variables": [
      "count",
      "events"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.edit.noEvents",
    "label": "Edit / no events",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 760,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.select",
    "label": "Edit / select",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 770,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.noMatches",
    "label": "Edit / no matches",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 780,
    "variables": [
      "query"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.refine",
    "label": "Edit / refine",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 790,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.choiceLabel",
    "label": "Edit / choice label",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 800,
    "variables": [
      "eventId",
      "range",
      "status",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.selectionStartedPrivate",
    "label": "Edit / selection started private",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 810,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.selectionStartedInGroupFallback",
    "label": "Edit / selection started in group fallback",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 820,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.selectionStartFailed",
    "label": "Edit / selection start failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 830,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.invalidSelection",
    "label": "Edit / invalid selection",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 840,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.selectionStale",
    "label": "Edit / selection stale",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 850,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.wrongRequester",
    "label": "Edit / wrong requester",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 860,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.edit.pollOpen",
    "label": "Edit / poll open",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 870,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.titleManaged",
    "label": "Title managed",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 880,
    "variables": [
      "eventId"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.titleManagedAmbiguous",
    "label": "Title managed ambiguous",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 890,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.titleOwnershipUnavailable",
    "label": "Title ownership unavailable",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 900,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.cancelHelp",
    "label": "Cancel help",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 910,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.started",
    "label": "Cancel / started",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 920,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.startFailed",
    "label": "Cancel / start failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 930,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.noEvents",
    "label": "Cancel / no events",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 940,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.permissionDenied",
    "label": "Cancel / permission denied",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 950,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.select",
    "label": "Cancel / select",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 960,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.choiceLabel",
    "label": "Cancel / choice label",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 970,
    "variables": [
      "eventId",
      "range",
      "status",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.summary",
    "label": "Cancel / summary",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 980,
    "variables": [
      "eventId",
      "range",
      "status",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.confirm",
    "label": "Cancel / confirm",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 990,
    "variables": [
      "summary"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.complete",
    "label": "Cancel / complete",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1000,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.cancelled",
    "label": "Cancel / cancelled",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1010,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.invalid",
    "label": "Cancel / invalid",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1020,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.done",
    "label": "Cancel / done",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1030,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.doneDeletionPending",
    "label": "Cancel / done deletion pending",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1040,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.staleArtifactNotice",
    "label": "Cancel / stale artifact notice",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1050,
    "variables": [
      "endsAt",
      "eventId",
      "startsAt",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.ended",
    "label": "Cancel / ended",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1060,
    "variables": [
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.notCancellable",
    "label": "Cancel / not cancellable",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1070,
    "variables": [
      "status",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.cancel.failed",
    "label": "Cancel / failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1080,
    "variables": [
      "reason",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "cancellation",
      "groupLabel": "Cancellation replies"
    }
  },
  {
    "key": "official.community-events.lifecycle.label",
    "label": "Lifecycle / label",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1090,
    "variables": [
      "eventStatus",
      "groupLifecycleStatus"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.event.active",
    "label": "Lifecycle / event / active",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1100,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.event.completed",
    "label": "Lifecycle / event / completed",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1110,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.event.cancelled",
    "label": "Lifecycle / event / cancelled",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1120,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.event.failed",
    "label": "Lifecycle / event / failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1130,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.group.poll_open",
    "label": "Lifecycle / group / poll_open",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1140,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.lifecycle.group.poll_closed",
    "label": "Lifecycle / group / poll_closed",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1150,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.lifecycle.group.cleanup_failed",
    "label": "Lifecycle / group / cleanup_failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1160,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.group.cleaned",
    "label": "Lifecycle / group / cleaned",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1170,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.group.missed",
    "label": "Lifecycle / group / missed",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1180,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.lifecycle.group.none",
    "label": "Lifecycle / group / none",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1190,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.flow.profile",
    "label": "Flow / profile",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1200,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.spanKind",
    "label": "Flow / span kind",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1210,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.publicationChoice",
    "label": "Flow / publication choice",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1220,
    "variables": [
      "closeAt",
      "endsAt",
      "startsAt",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.pollDeadlinePassed",
    "label": "Flow / poll deadline passed",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1230,
    "variables": [
      "closeAt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.pollPhase",
    "label": "Flow / poll phase",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1240,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.pollPhase.poll",
    "label": "Flow / poll phase / poll",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1250,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.pollPhase.unplanned",
    "label": "Flow / poll phase / unplanned",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1260,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.pollClose.usage",
    "label": "Poll close / usage",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1270,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.select",
    "label": "Poll close / select",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1280,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.confirm",
    "label": "Poll close / confirm",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1290,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.confirmYes",
    "label": "Poll close / confirm yes",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1300,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.confirmNo",
    "label": "Poll close / confirm no",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1310,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.cancelled",
    "label": "Poll close / cancelled",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1320,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.confirmStartFailed",
    "label": "Poll close / confirm start failed",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1330,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.noMatches",
    "label": "Poll close / no matches",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1340,
    "variables": [
      "query"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.noEvents",
    "label": "Poll close / no events",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1350,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.permissionDenied",
    "label": "Poll close / permission denied",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1360,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.unavailable",
    "label": "Poll close / unavailable",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1370,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.pollClose.queued",
    "label": "Poll close / queued",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1380,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.help.pollClose",
    "label": "Help / poll close",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 1390,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.pollClose.title",
    "label": "Help / poll close / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 1400,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.pollClose.instruction",
    "label": "Help / poll close / instruction",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 1410,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.pollClose.example",
    "label": "Help / poll close / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 1420,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.flow.endDate",
    "label": "Flow / end date",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1430,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.endTime",
    "label": "Flow / end time",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1440,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.endInvalid",
    "label": "Flow / end invalid",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1450,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.span.dayTrip",
    "label": "Span / day trip",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1460,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.span.multiDay",
    "label": "Span / multi day",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1470,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "status",
      "groupLabel": "Listings and status wording"
    }
  },
  {
    "key": "official.community-events.flow.confirm",
    "label": "Flow / confirm",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1480,
    "variables": [
      "summary"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.confirmSummary",
    "label": "Flow / confirm summary",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1490,
    "variables": [
      "endsAt",
      "profile",
      "span",
      "startsAt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.complete",
    "label": "Flow / complete",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1500,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.yes",
    "label": "Flow / yes",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1510,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.no",
    "label": "Flow / no",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1520,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "creation",
      "groupId": "creation",
      "groupLabel": "Creation and confirmation replies"
    }
  },
  {
    "key": "official.community-events.flow.currentValuePrompt",
    "label": "Flow / current value prompt",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1530,
    "variables": [
      "current",
      "prompt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.editChoicePrompt",
    "label": "Flow / edit choice prompt",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1540,
    "variables": [
      "current",
      "prompt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.editTextPrompt",
    "label": "Flow / edit text prompt",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1550,
    "variables": [
      "current",
      "prompt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.unset",
    "label": "Flow / unset",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1560,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.datePrompt",
    "label": "Flow / date prompt",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1570,
    "variables": [
      "prompt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.timePrompt",
    "label": "Flow / time prompt",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1580,
    "variables": [
      "prompt"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.optionalPromptSuffix",
    "label": "Flow / optional prompt suffix",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1590,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.dateHasTime",
    "label": "Flow / date has time",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1600,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.dateInvalid",
    "label": "Flow / date invalid",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1610,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.dateUnsupportedLocale",
    "label": "Flow / date unsupported locale",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1620,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.timeInvalid",
    "label": "Flow / time invalid",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1630,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.datetimeInvalid",
    "label": "Flow / datetime invalid",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1640,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.datetimePast",
    "label": "Flow / datetime past",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1650,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.datetimeTooFar",
    "label": "Flow / datetime too far",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1660,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.flow.datetimeUnsupportedLocale",
    "label": "Flow / datetime unsupported locale",
    "topic": "Event creation",
    "destination": "Command or workflow reply",
    "order": 1670,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "questions",
      "groupId": "questions",
      "groupLabel": "Question replies and validation"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.band.question",
    "label": "Start time agreement / band / question",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1680,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.organizerBand.question",
    "label": "Start time agreement / organizer band / question",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1690,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.exact.question",
    "label": "Start time agreement / exact / question",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1700,
    "variables": [
      "band"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.organizerTime.question",
    "label": "Start time agreement / organizer time / question",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1710,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.band.morning",
    "label": "Start time agreement / band / morning",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1720,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.band.afternoon",
    "label": "Start time agreement / band / afternoon",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1730,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.band.evening",
    "label": "Start time agreement / band / evening",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1740,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.applied",
    "label": "Start time agreement / applied",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1750,
    "variables": [
      "time"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.manualRequired",
    "label": "Start time agreement / manual required",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1760,
    "variables": [
      "eventId"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.eventDayManualRequired",
    "label": "Start time agreement / event day manual required",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1770,
    "variables": [
      "eventId"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.startTimeAgreement.blocked",
    "label": "Start time agreement / blocked",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1780,
    "variables": [
      "eventId"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "start-time",
      "groupId": "start-time",
      "groupLabel": "Start-time replies"
    }
  },
  {
    "key": "official.community-events.update.startedPrivate",
    "label": "Update / started private",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1790,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.startedInGroupFallback",
    "label": "Update / started in group fallback",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1800,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.privateStartFailed",
    "label": "Update / private start failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1810,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.startFailed",
    "label": "Update / start failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1820,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.confirm",
    "label": "Update / confirm",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1830,
    "variables": [
      "summary"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.confirmOpenPoll",
    "label": "Update / confirm open poll",
    "topic": "Attendance & polls",
    "destination": "Command or workflow reply",
    "order": 1840,
    "variables": [
      "summary"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "poll",
      "groupId": "poll",
      "groupLabel": "Poll replies"
    }
  },
  {
    "key": "official.community-events.update.confirmPastCompletion",
    "label": "Update / confirm past completion",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1850,
    "variables": [
      "summary"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.complete",
    "label": "Update / complete",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1860,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.cancelled",
    "label": "Update / cancelled",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 1870,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.invalid",
    "label": "Update / invalid",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1880,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.ambiguous",
    "label": "Update / ambiguous",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1890,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.pastCompletionConfirmationRequired",
    "label": "Update / past completion confirmation required",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1900,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.convertedToUnplanned",
    "label": "Update / converted to unplanned",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1910,
    "variables": [
      "endsAt",
      "eventId",
      "startsAt",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.convertedNotice",
    "label": "Update / converted notice",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1920,
    "variables": [
      "endsAt",
      "eventId",
      "groupJoinUrl",
      "startsAt",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.convertedNoticePending",
    "label": "Update / converted notice pending",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1930,
    "variables": [
      "endsAt",
      "eventId",
      "startsAt",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.permissionDenied",
    "label": "Update / permission denied",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1940,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.done",
    "label": "Update / done",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1950,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.doneRepairPending",
    "label": "Update / done repair pending",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1960,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.noChanges",
    "label": "Update / no changes",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1970,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.donePastCompletion",
    "label": "Update / done past completion",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1980,
    "variables": [
      "cleanupAt",
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.donePastCompletionRepairPending",
    "label": "Update / done past completion repair pending",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 1990,
    "variables": [
      "cleanupAt",
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.failed",
    "label": "Update / failed",
    "topic": "Recovery & status",
    "destination": "Command or workflow reply",
    "order": 2000,
    "variables": [],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.replacementQueued",
    "label": "Update / replacement queued",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 2010,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.update.replacementExpired",
    "label": "Update / replacement expired",
    "topic": "General replies",
    "destination": "Command or workflow reply",
    "order": 2020,
    "variables": [
      "eventId",
      "title"
    ],
    "placement": {
      "sectionId": "events-recovery",
      "groupId": "editing",
      "groupLabel": "Event editing replies"
    }
  },
  {
    "key": "official.community-events.profile.climbing.label",
    "label": "Profile / climbing / label",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2030,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.question.place",
    "label": "Profile / climbing / question / place",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2040,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.question.startDate",
    "label": "Profile / climbing / question / start date",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2050,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.question.startTime",
    "label": "Profile / climbing / question / start time",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2060,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.question.style",
    "label": "Profile / climbing / question / style",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2070,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.poll.titleTemplate",
    "label": "Profile / climbing / poll / title template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2080,
    "variables": [
      "creatorDisplayName",
      "dd",
      "hour",
      "minute",
      "mm",
      "place",
      "startTime",
      "style",
      "weekday",
      "yy"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.group.titleTemplate",
    "label": "Profile / climbing / group / title template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2090,
    "variables": [
      "dd",
      "hour",
      "minute",
      "mm",
      "place",
      "startTime",
      "style",
      "weekday",
      "yy"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.eventGroupHint.template",
    "label": "Profile / climbing / event group hint / template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2100,
    "variables": [
      "creatorDisplayName",
      "groupDisplayName",
      "groupJoinUrl"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.eventEditAnnouncement.template",
    "label": "Profile / climbing / event edit announcement / template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2110,
    "variables": [
      "editorDisplayName",
      "groupDisplayName"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.calendar.titleTemplate",
    "label": "Profile / climbing / calendar / title template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2120,
    "variables": [
      "place",
      "style"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.calendar.hint.template",
    "label": "Profile / climbing / calendar / hint / template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2130,
    "variables": [
      "calendarDisplayName",
      "calendarSubscriptionUrl",
      "creatorDisplayName"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.weather.template",
    "label": "Profile / climbing / weather / template",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2140,
    "variables": [
      "groupDisplayName",
      "weatherDate",
      "weatherSummary"
    ],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.responseClass.event_group_member",
    "label": "Profile / climbing / response class / event_group_member",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2150,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.poll.option.going",
    "label": "Profile / climbing / poll / option / going",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2160,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.profile.climbing.poll.option.ride",
    "label": "Profile / climbing / poll / option / ride",
    "topic": "Profile defaults",
    "destination": "Command or workflow reply",
    "order": 2170,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "groupId": "profile-defaults",
      "groupLabel": "Default profile wording"
    }
  },
  {
    "key": "official.community-events.weather.section.temperature",
    "label": "Weather / section / temperature",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2180,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.section.relativeHumidity",
    "label": "Weather / section / relative humidity",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2190,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.section.precipitation",
    "label": "Weather / section / precipitation",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2200,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.section.wind",
    "label": "Weather / section / wind",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2210,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.temperatureMax",
    "label": "Weather / metric / temperature max",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2220,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.temperatureMin",
    "label": "Weather / metric / temperature min",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2230,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.relativeHumidityMax",
    "label": "Weather / metric / relative humidity max",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2240,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.relativeHumidityMin",
    "label": "Weather / metric / relative humidity min",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2250,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.relativeHumidityMean",
    "label": "Weather / metric / relative humidity mean",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2260,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.precipitation",
    "label": "Weather / metric / precipitation",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2270,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.precipitationProbability",
    "label": "Weather / metric / precipitation probability",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2280,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.windSpeed",
    "label": "Weather / metric / wind speed",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2290,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.windGust",
    "label": "Weather / metric / wind gust",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2300,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.windDirection",
    "label": "Weather / metric / wind direction",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2310,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.metric.weatherCode",
    "label": "Weather / metric / weather code",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2320,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.weather.none",
    "label": "Weather / none",
    "topic": "Calendar & weather",
    "destination": "Command or workflow reply",
    "order": 2330,
    "variables": [],
    "placement": {
      "sectionId": "event-profiles",
      "controlId": "plugin.official.community-events.eventProfiles",
      "slotId": "weather",
      "groupId": "weather",
      "groupLabel": "Weather wording"
    }
  },
  {
    "key": "official.community-events.help.family",
    "label": "Help / family",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2340,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.command",
    "label": "Help / command",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2350,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.status",
    "label": "Help / status",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2360,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.cancel",
    "label": "Help / cancel",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2370,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.edit",
    "label": "Help / edit",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2380,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.edit.example",
    "label": "Help / edit / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2390,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.list",
    "label": "Help / list",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2400,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.list.example",
    "label": "Help / list / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2410,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.feature.title",
    "label": "Help / feature / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2420,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.feature.summary",
    "label": "Help / feature / summary",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2430,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.overview.example",
    "label": "Help / overview / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2440,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.create.title",
    "label": "Help / create / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2450,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.create.summary",
    "label": "Help / create / summary",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2460,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.create.instruction",
    "label": "Help / create / instruction",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2470,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.create.example",
    "label": "Help / create / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2480,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.edit.title",
    "label": "Help / edit / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2490,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.edit.summary",
    "label": "Help / edit / summary",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2500,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.edit.instruction",
    "label": "Help / edit / instruction",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2510,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.list.title",
    "label": "Help / list / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2520,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.list.summary",
    "label": "Help / list / summary",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2530,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.list.instruction",
    "label": "Help / list / instruction",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2540,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.inspect.title",
    "label": "Help / inspect / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2550,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.inspect.summary",
    "label": "Help / inspect / summary",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2560,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.status.example",
    "label": "Help / status / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2570,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.cancel.title",
    "label": "Help / cancel / title",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2580,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.cancel.summary",
    "label": "Help / cancel / summary",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2590,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.cancel.instruction",
    "label": "Help / cancel / instruction",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2600,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  },
  {
    "key": "official.community-events.help.cancel.example",
    "label": "Help / cancel / example",
    "topic": "Help & commands",
    "destination": "Command or workflow reply",
    "order": 2610,
    "variables": [],
    "placement": {
      "sectionId": "general",
      "groupId": "help",
      "groupLabel": "Help and command replies"
    }
  }
];
