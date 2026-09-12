import { scopeTimezoneSchema } from '../../../../packages/plugin-sdk/src/clock';
import { z } from 'zod';

export const GEOCODER_SERVICE_ID = 'official.geocoder.v1';
export const GEOCODER_GEOCODE_METHOD = 'geocode';
export const GEOCODER_REVERSE_GEOCODE_METHOD = 'reverseGeocode';
export const GEOCODER_MAP_LINKS_METHOD = 'mapLinks';
export const GEOCODER_TIMEZONE_METHOD = 'timezoneForPoint';

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
