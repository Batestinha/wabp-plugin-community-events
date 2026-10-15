# Community Events

Community events, attendance polls, subgroup creation and recovery, calendar publication, and event weather reports.

Standalone WABS package `official.community-events` version `0.19.1`, requiring WABP core API `^0.3.14`. It retains the plugin ID, account-owned `events` database, data version 21, all SQL migrations, scoped configuration, event identifiers, creator bindings, subgroup checkpoints and receipt formats.

Workflow discovery resolves “this event” only from a unique, authorized event whose subgroup matches the invoking chat, independently of title, search and pagination. Explicit event selections remain authoritative. Read-only `locationQuery` discovery returns validated geocoder-backed location candidates and timezones; ambiguous candidates still require a choice before preparation.

The retained 0.17.2 source was reconciled with the installed 0.17.5 package before this release. `recovery/live-0.17.5.json` records matching compiled files and the intentional discovery change; the missing original Git history is not claimed to have been recovered. The SDK pin is corrected to support the live interactive-job fields.

New event timezones are inferred from the coordinates returned by the existing geocoder disambiguation. There is no separate timezone question. Relative dates use the selected location and the original answer instant, including after restart. Persisted event timezone snapshots govern event-group clock behavior; scope clocks supply other defaults. Existing saved civil dates and UTC schedules remain fixed unless the event is explicitly edited.

WABP supplies authorized group and workflow operations, identities, plugin-owned storage, database migrations, transport and durable job scheduling. Creation uncertainty and completed checkpoints remain recognizable across installed packages, so uncertain group creation must be reconciled before retrying.

The package contains the portable SDK, exact runtime dependencies, Portuguese translations and explicitly vendored interoperability schemas, a marine presentation helper and connection configuration helper. It includes no geocoder boundary database, weather provider implementation, workspace server or WABP host runtime. Pristine upstream bytes, source commits, checksums, licenses and import-only patches are recorded in `contracts/provenance.json`. Packaging reconstructs every vendored file and rejects drift or patch conflicts.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, reproduces the archive twice and loads it outside the repository. Tests use local fixtures and mocked effects. The WABS registry pins immutable release bytes by SHA-256. Installation and scope enablement are separate operations.

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

## Community wording and settings

Each community or group now owns its saved message catalogs and localized profile text. Package English and Portuguese catalogs seed new configurations and new required keys; upgrades and language-pack refreshes never replace saved wording. Profile labels, questions, choices, poll options, titles, announcements and calendar text retain their original text in the initial language variants. The migration snapshots enabled installed catalogs and the original configuration layers in one transaction before writing. Existing event/flow snapshots and already rendered delivery jobs are unchanged.

Open Community Events in the console sidebar and select the bot and community. WABP generates the same settings workspace for every configurable plugin. The sections are General, Event profiles, Calendars, and Events & recovery. Edit profile wording beside its behavior settings; shared bot replies appear in expandable groups at explicit feature slots. These replies apply to all profiles in the selected community/group. Workspace search opens the relevant section and reply group.

WABP's token, condition and mention editors retain their destination-specific capabilities. Source edits automatically update the saved translations; translated wording remains available beside each editor. Autosave preserves active drafts and cursor position. A conflict keeps the draft for review. The 0.19.1 layout uses the existing stored text format and does not reset wording.

Install the compatible WABP host before installing this package. The idempotent migration backup key is `configuration-migration:<account-id>:saved-event-text-v1-0.18.0`. Version 0.19.1 only reorganizes settings metadata and preserves existing configuration; reverting to 0.18.0 does not require restoring text. To roll back the original saved-text migration, stop affected runtimes, restore this snapshot with WABP's `scripts/restore-plugin-configuration.mjs`, and restore the matching previous plugin package before restarting. The restore command first saves all current configuration layers under the corresponding `restore-` migration key, preserving edits made after the upgrade. Retain both snapshots and the previous immutable package until rollback is no longer required.
