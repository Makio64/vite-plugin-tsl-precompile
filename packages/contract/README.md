# @tsl-precompile/contract

Internal shared contract between
[`vite-plugin-tsl-precompile`](https://www.npmjs.com/package/vite-plugin-tsl-precompile)
and [`@tsl-precompile/runtime`](https://www.npmjs.com/package/@tsl-precompile/runtime).

Holds the cross-package vocabulary: source-kind registry, texture-property
lists, deterministic attribute recipes, exact object-attribute references,
graph normalization, and artifact
validation. Not a standalone API; you do
not need to install this package directly — both consumer packages already
depend on it.

Generated virtual modules automatically materialize `range@1` and
`instance-matrix@1` replay handoffs. A low-level consumer that loads captured
JSON directly must call `materializeArtifactAttributeDescriptors( artifact )`
from `@tsl-precompile/contract/attribute-generators` before manual registration
or `hydrateNodeBuilderState()`; undecorated generated descriptors fail loudly
instead of producing zero-filled data.

See [AGENTS.md → Change Rules](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/AGENTS.md)
for the contract-first development rule.

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
