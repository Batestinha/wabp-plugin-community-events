import type { WorkspaceConnectorDeploymentConfig } from './contracts/workspace-connector/config';
export interface EventsDeploymentConfig extends WorkspaceConnectorDeploymentConfig {
  PLUGIN_DATABASE_DIR: string;
  WHATSAPP_ACCOUNT_ID: string;
  RUNTIME_BINDING_ID: string;
  EVENT_CALENDAR_PUBLICATION_MODE?: 'legacy' | 'dual' | 'workspace' | undefined;
  piwigoCalendarPublicationSecret?: string | undefined;
  TOPOMARE_OIDC_ISSUER?: string | undefined;
  TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID?: string | undefined;
  topomareWabpGalleryServiceOidcClientSecret?: string | undefined;
}
export type AppConfig = EventsDeploymentConfig;
