/**
 * Compatibility shim: TokenRegistry and createRegistryAuthorizer moved to
 * `src/console/token-registry.ts` (Task 3 of the console PWA plan). This
 * re-export keeps the demo site and its tests working until `src/demo/` is
 * deleted wholesale in Task 10. DEMO_PRINCIPAL stays here: it is demo-only.
 */
export * from "../console/token-registry.js";

/** Every demo token authorizes as one constant principal so the demo
 * router can enqueue offers without ownership conflicts. */
export const DEMO_PRINCIPAL = "demo-user";
