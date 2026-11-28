/**
 * Which engine this is. The dashboard asserts on it so a registry build of the
 * upstream package can never be mistaken for the fork-local strict engine.
 *
 * Kept in step with package.json by tests/engine-identity.test.ts.
 */
export const ENGINE_VARIANT = "xantform-strict-inplace" as const;
export const ENGINE_PACKAGE_VERSION = "0.15.0-xantform.strict.1" as const;
