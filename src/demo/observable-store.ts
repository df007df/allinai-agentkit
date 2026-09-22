/**
 * Compatibility shim: ObservableStore and the HubObservation types moved to
 * `src/console/observable-store.ts` (Task 4 of the console PWA plan). This
 * re-export keeps the demo projection/site and their tests working until
 * `src/demo/` is deleted wholesale in Task 10.
 */
export * from "../console/observable-store.js";
