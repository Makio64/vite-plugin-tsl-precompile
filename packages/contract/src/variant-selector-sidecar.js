/**
 * Non-serializable handoff installed by generated artifact modules.
 *
 * Keep this symbol in its own module so the checked prebuilt renderer can
 * consume the handoff without retaining the static selector-analysis code
 * that creates it.
 */
export const GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR = Symbol.for(
	'@tsl-precompile/generated-variant-selector-adapter@1',
);
