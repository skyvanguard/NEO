/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @neo/client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@neo/cordis',
  '@neo/client-ui-slots',
  '@neo/client-web-react',
  '@neo/client-ui-primitives',
  '@neo/client-ui-attachment',
  '@neo/client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
