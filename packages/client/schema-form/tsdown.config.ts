import { clientLibrary } from '../tsdown.client.ts'

export default clientLibrary(
  '@neo/client-schema-form',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
