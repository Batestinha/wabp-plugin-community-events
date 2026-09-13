# Community Events

Community events, attendance polls, subgroup creation and recovery, calendar publication, and event weather reports.

Standalone WABS package `official.community-events` version `0.15.1`, requiring WABP core API `^0.3.4`. It retains the plugin ID, account-owned `events` database, data version 18, all SQL migrations, scoped configuration, event identifiers, creator bindings, subgroup checkpoints and receipt formats.

New event timezones are inferred from the coordinates returned by the existing geocoder disambiguation. There is no separate timezone question. Relative dates use the selected location and the original answer instant, including after restart. Persisted event timezone snapshots govern event-group clock behavior; scope clocks supply other defaults. Existing saved civil dates and UTC schedules remain fixed unless the event is explicitly edited.

WABP supplies authorized group and workflow operations, identities, plugin-owned storage, database migrations, transport and durable job scheduling. Creation uncertainty and completed checkpoints remain recognizable across installed packages, so uncertain group creation must be reconciled before retrying.

The package contains the portable SDK, exact runtime dependencies, Portuguese translations and explicitly vendored interoperability schemas, a marine presentation helper and connection configuration helper. It includes no geocoder boundary database, weather provider implementation, workspace server or WABP host runtime. Pristine upstream bytes, source commits, checksums, licenses and import-only patches are recorded in `contracts/provenance.json`. Packaging reconstructs every vendored file and rejects drift or patch conflicts.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, reproduces the archive twice and loads it outside the repository. Tests use local fixtures and mocked effects. Trusted WABS signatures identify immutable release bytes. Installation and scope enablement are separate operations.

The package owns its console operations and runtime administration actions, including calendar subscriptions, token rotation, question-key rename recovery, adoption and cancellation. WABP retains the existing routes and supplies account-bound configuration, read-only inspection databases, revision-checked updates and authorization. Runtime readiness performs recovery through the host contract; background sweeps drain before shutdown.
