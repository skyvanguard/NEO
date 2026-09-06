/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @neo/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@neo/cordis',
  '@neo/dsh-client-ui-slots',
  '@neo/dsh-client-web-react',
  '@neo/dsh-client-ui-primitives',
  '@neo/dsh-client-ui-attachment',
  '@neo/dsh-client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
