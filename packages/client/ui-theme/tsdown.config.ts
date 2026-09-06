import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@neo/dsh-client-ui-theme',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  {
    lib: {
      copy: [{ from: 'src/styles/*', to: 'lib/styles' }],
    },
  },
)
