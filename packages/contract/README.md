# @tsl-precompile/contract

Internal shared contract between
[`vite-plugin-tsl-precompile`](https://www.npmjs.com/package/vite-plugin-tsl-precompile)
and [`@tsl-precompile/runtime`](https://www.npmjs.com/package/@tsl-precompile/runtime).

Holds the cross-package vocabulary: source-kind registry, texture-property
lists, graph normalization, artifact validator. Not a standalone API; you do
not need to install this package directly — both consumer packages already
depend on it.

See [AGENTS.md → Change Rules](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/AGENTS.md)
for the contract-first development rule.

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
