import { scopeTimezoneSchema } from '@wabs/plugin-sdk/clock';
import { z } from 'zod';

export const GEOCODER_SERVICE_ID = 'official.geocoder.v1';
export const GEOCODER_GEOCODE_METHOD = 'geocode';
export const GEOCODER_REVERSE_GEOCODE_METHOD = 'reverseGeocode';
export const GEOCODER_MAP_LINKS_METHOD = 'mapLinks';
export const GEOCODER_TIMEZONE_METHOD = 'timezoneForPoint';
/** Which place a person means: cleaned query, this scope's remembered places, area bias, ranking and a confidence decision. */
export const GEOCODER_RESOLVE_METHOD = 'resolve';
/** What a reply to a numbered place list means: a pick, a new search, or a request to answer with the number. */
export const GEOCODER_CHOOSE_METHOD = 'choose';
/** Teach this scope's place memory a confirmed choice (or import past ones). */
export const GEOCODER_REMEMBER_METHOD = 'remember';

export const geocoderPointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180)
}).strict();

export const geocoderTimezoneOutputSchema = z.object({
  timezone: scopeTimezoneSchema.nullable(),
  candidates: z.array(scopeTimezoneSchema)
}).strict();

export const geocoderBoundingBoxSchema = z.object({
  south: z.number().finite().min(-90).max(90),
  west: z.number().finite().min(-180).max(180),
  north: z.number().finite().min(-90).max(90),
  east: z.number().finite().min(-180).max(180)
}).strict().superRefine((bounds, context) => {
  if (bounds.south > bounds.north) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['south'],
      message: 'south must not be greater than north'
    });
  }
  if (bounds.west > bounds.east) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['west'],
      message: 'west must not be greater than east'
    });
  }
});

export const geocoderAddressSchema = z.object({
  houseNumber: z.string().trim().min(1).max(128).optional(),
  street: z.string().trim().min(1).max(512).optional(),
  locality: z.string().trim().min(1).max(256).optional(),
  district: z.string().trim().min(1).max(256).optional(),
  city: z.string().trim().min(1).max(256).optional(),
  county: z.string().trim().min(1).max(256).optional(),
  state: z.string().trim().min(1).max(256).optional(),
  postcode: z.string().trim().min(1).max(64).optional(),
  country: z.string().trim().min(1).max(256).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional()
}).strict();

export const geocoderAttributionSchema = z.object({
  text: z.string().trim().min(1).max(1024),
  url: z.string().url()
}).strict();

export const geocoderPlaceSchema = z.object({
  label: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(512).optional(),
  point: geocoderPointSchema,
  timezone: scopeTimezoneSchema.optional(),
  address: geocoderAddressSchema,
  boundingBox: geocoderBoundingBoxSchema.optional(),
  category: z.string().trim().min(1).max(128).optional(),
  type: z.string().trim().min(1).max(128).optional(),
  providerRef: z.string().trim().min(1).max(256).optional(),
  attribution: geocoderAttributionSchema
}).strict();

export const geocodeInputSchema = z.object({
  query: z.string().trim().min(2).max(256),
  language: z.string().trim().min(2).max(35).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  countryCodes: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(10).optional(),
  bounds: geocoderBoundingBoxSchema.optional(),
  restrictToBounds: z.boolean().default(false)
}).strict().superRefine((input, context) => {
  if (input.restrictToBounds && !input.bounds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['restrictToBounds'],
      message: 'bounds are required when restrictToBounds is true'
    });
  }
});

export const reverseGeocodeInputSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  language: z.string().trim().min(2).max(35).optional()
}).strict();

export const geocodeOutputSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  fetchedAt: z.string().datetime(),
  results: z.array(geocoderPlaceSchema).max(10)
}).strict();

export const reverseGeocodeOutputSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  fetchedAt: z.string().datetime(),
  place: geocoderPlaceSchema.nullable()
}).strict();

export const mapLinksInputSchema = geocoderPointSchema.extend({
  label: z.string().trim().min(1).max(512).optional(),
  zoom: z.number().int().min(0).max(19).default(15)
}).strict();

export const mapLinksOutputSchema = z.object({
  openStreetMapUrl: z.string().url(),
  geoUri: z.string().startsWith('geo:')
}).strict();

export const GEOCODER_RESOLVE_STATUSES = ['resolved', 'ambiguous', 'not_found'] as const;

export const resolveInputSchema = z.object({
  /** What the person typed; notes such as "(maybe?)" and alternatives ("A/B", "A ou B") are left out of the search. */
  query: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(35).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  countryCodes: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(10).optional(),
  /** Answer from this scope's remembered places only, without asking the provider. */
  memoryOnly: z.boolean().default(false)
}).strict();

export const resolvedCandidateSchema = z.object({
  place: geocoderPlaceSchema,
  /** Name plus the region and country that tell it apart, e.g. "Lagos, Faro, Portugal". */
  shortLabel: z.string().trim().min(1).max(512),
  /** This scope confirmed this place before. */
  remembered: z.boolean(),
  /** The place is named exactly what was searched. */
  nameMatch: z.boolean()
}).strict();

export const resolveOutputSchema = z.object({
  /**
   * resolved: candidates[0] is the place meant (remembered for this text, the only result, or the only one with
   * that name in this scope's area). ambiguous: candidates[0] is only the best guess. not_found: no candidates.
   */
  status: z.enum(GEOCODER_RESOLVE_STATUSES),
  query: z.string(),
  searchQuery: z.string(),
  /** candidates[0] came from this scope's memory of that exact text. */
  remembered: z.boolean(),
  provider: z.string().trim().min(1).max(128),
  fetchedAt: z.string().datetime(),
  /** Best first; at most `limit`. */
  candidates: z.array(resolvedCandidateSchema).max(10),
  presentation: z.object({
    /** "1. Sintra, Lisboa, Portugal" lines for a numbered list. */
    optionLines: z.array(z.string()),
    /** The same entries without numbers, for menus that number their own options. */
    optionLabels: z.array(z.string()),
    /** One line naming the other places when status is ambiguous, for replies that use the best guess. */
    alternatives: z.string().optional()
  }).strict()
}).strict();

export const chooseInputSchema = z.object({
  /** The searchQuery the list came from. */
  searchQuery: z.string().trim().min(1).max(512),
  status: z.enum(GEOCODER_RESOLVE_STATUSES),
  /** The places exactly as listed, in order. */
  candidates: z.array(geocoderPlaceSchema).max(10),
  reply: z.string().max(1024),
  language: z.string().trim().min(2).max(35).optional()
}).strict();

export const chooseOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('selected'), index: z.number().int().min(0), place: geocoderPlaceSchema }).strict(),
  /** The reply is a new search text. */
  z.object({ status: z.literal('search'), query: z.string() }).strict(),
  /** The same search again: answer with the number (text repeats the list). */
  z.object({ status: z.literal('ask_number'), text: z.string() }).strict(),
  /** A number that is not listed, or a command. */
  z.object({ status: z.literal('invalid') }).strict()
]);

export const rememberInputSchema = z.object({
  places: z.array(z.object({
    /** What the person typed for this place. */
    query: z.string().trim().min(1).max(512),
    place: geocoderPlaceSchema,
    /** When it was chosen (imports); defaults to now. */
    usedAt: z.string().datetime().optional()
  }).strict()).min(1).max(200),
  /** confirmed: a person just chose it (counts a use). import: past choices; only adds what is missing. */
  source: z.enum(['confirmed', 'import']).default('confirmed')
}).strict();

export const rememberOutputSchema = z.object({
  places: z.number().int().min(0),
  changed: z.boolean()
}).strict();

export type GeocoderPoint = z.infer<typeof geocoderPointSchema>;
export type GeocoderBoundingBox = z.infer<typeof geocoderBoundingBoxSchema>;
export type GeocoderAddress = z.infer<typeof geocoderAddressSchema>;
export type GeocoderAttribution = z.infer<typeof geocoderAttributionSchema>;
export type GeocoderPlace = z.infer<typeof geocoderPlaceSchema>;
export type GeocodeInput = z.infer<typeof geocodeInputSchema>;
export type GeocodeOutput = z.infer<typeof geocodeOutputSchema>;
export type ReverseGeocodeInput = z.infer<typeof reverseGeocodeInputSchema>;
export type ReverseGeocodeOutput = z.infer<typeof reverseGeocodeOutputSchema>;
export type MapLinksInput = z.infer<typeof mapLinksInputSchema>;
export type MapLinksOutput = z.infer<typeof mapLinksOutputSchema>;
export type GeocoderResolveStatus = typeof GEOCODER_RESOLVE_STATUSES[number];
export type ResolveInput = z.infer<typeof resolveInputSchema>;
export type ResolvedCandidate = z.infer<typeof resolvedCandidateSchema>;
export type ResolveOutput = z.infer<typeof resolveOutputSchema>;
export type ChooseInput = z.infer<typeof chooseInputSchema>;
export type ChooseOutput = z.infer<typeof chooseOutputSchema>;
export type RememberInput = z.infer<typeof rememberInputSchema>;
export type RememberOutput = z.infer<typeof rememberOutputSchema>;
