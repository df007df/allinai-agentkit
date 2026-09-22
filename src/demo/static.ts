/**
 * Compatibility shim: the static handler moved to `src/console/static.ts`
 * (Task 2 of the console PWA plan). This re-export keeps the demo site and
 * its tests working until `src/demo/` is deleted wholesale in Task 10.
 */
export { createStaticHandler, resolveWebRoot } from "../console/static.js";
