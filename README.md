# Community Events

Community events, attendance polls, subgroup creation and recovery, calendar publication, and event weather reports.

Standalone WABS package `official.community-events` version `0.15.1`, requiring WABP core API `^0.3.4`. It retains the plugin ID, account-owned `events` database, data version 18, all SQL migrations, scoped configuration, event identifiers, creator bindings, subgroup checkpoints and receipt formats.

New event timezones are inferred from the coordinates returned by the existing geocoder disambiguation. There is no separate timezone question. Relative dates use the selected location and the original answer instant, including after restart. Persisted event timezone snapshots govern event-group clock behavior; scope clocks supply other defaults. Existing saved civil dates and UTC schedules remain fixed unless the event is explicitly edited.

WABP supplies authorized group and workflow operations, identities, plugin-owned storage, database migrations, transport and durable job scheduling. Creation uncertainty and completed checkpoints remain recognizable across installed packages, so uncertain group creation must be reconciled before retrying.

The package contains the portable SDK, exact runtime dependencies, Portuguese translations and explicitly vendored interoperability schemas, a marine presentation helper and connection configuration helper. It includes no geocoder boundary database, weather provider implementation, workspace server or WABP host runtime. Pristine upstream bytes, source commits, checksums, licenses and import-only patches are recorded in `contracts/provenance.json`. Packaging reconstructs every vendored file and rejects drift or patch conflicts.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, reproduces the archive twice and loads it outside the repository. Tests use local fixtures and mocked effects. Trusted WABS signatures identify immutable release bytes. Installation and scope enablement are separate operations.

The package owns its console operations and runtime administration actions, including calendar subscriptions, token rotation, question-key rename recovery, adoption and cancellation. WABP retains the existing routes and supplies account-bound configuration, read-only inspection databases, revision-checked updates and authorization. Runtime readiness performs recovery through the host contract; background sweeps drain before shutdown.

## Typed templates and WhatsApp mentions

Message editors support exact choice and text comparisons, numeric thresholds,
boolean values, availability checks, nested All/Any rules and Otherwise branches.
Existing bare conditions retain their original presence meaning. Comparisons use
canonical values separately from translated display text; missing values do not
satisfy negative comparisons, while zero and false remain available.

Type `@` in a supported message body or caption to insert a person, a group link,
or a contextual recipient. Group links and native all-members mentions are distinct;
the editor only offers targets supported by that destination. Mentions in hidden
branches do not resolve or notify anyone. Native poll titles/options, group names
and calendar text remain plain text. Durable delivery stores rendered text and
recipient metadata together so retries keep the original notification intent.

Choice conditions use stable option IDs. Saved events retain raw answers alongside
readable answers; legacy values are backfilled only when their current choice is
unambiguous. Question-key renames update both representations transactionally.

## Event creation and optional answers

New creation flows collect event details, confirmation and the final location first. The creator then chooses between an attendance poll and immediate group creation only while the poll deadline is still in the future. Events whose poll deadline has already passed go directly to group creation. If that deadline passes while the final choice is open, choosing a poll explains the deadline and creates the group directly. The final choice survives runtime restart and uses the original creation ID to prevent duplicate events. Existing creation sessions keep their original question order.

Optional questions use the platform's shared `/skip` control and unreserved symbol-only replies such as `.`. During editing, `/keep` or `=` restores the original saved answer, including an omission; another answer replaces it. Saved answers remain subject to date and cross-field validation. Platform navigation instructions replace the old optional-question instruction setting for new sessions; stored settings remain compatible with legacy sessions.
