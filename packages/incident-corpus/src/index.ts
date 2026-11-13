/**
 * @routespec/incident-corpus — scenarios from observed incidents (module M50).
 *
 * A read-only importer for the Intents Explorer API, sanitisation of swap records into closed
 * incident descriptors, scenario templates, and the `mainnet-observed-2026-11` corpus with its
 * provenance and counts. The only code here that opens a network connection is
 * `ExplorerHttpSource`, and only to the pinned Explorer origin. Raw records are never written
 * to disk; nothing outside closed enumerations, counts and hour-rounded times is kept.
 */
export * from './explorer-shape.ts';
export * from './sanitize.ts';
export * from './templates.ts';
export * from './source.ts';
export * from './client.ts';
export * from './import.ts';
export * from './corpus.ts';
export * from './register.ts';
export {
  DEFAULT_REQUIRED_INVARIANTS,
  INCIDENTS_CLI_REVISION,
  INCIDENTS_COMMAND_NAMES,
  runIncidentsCli,
  type IncidentsIo,
} from './main.ts';
