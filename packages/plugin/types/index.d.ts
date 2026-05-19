import type { Plugin } from 'vite';

export interface TslPrecompileOptions {
	/** Where captured artifacts live on disk. Default: `'./artifacts'`. */
	artifactsDir?: string;
	/**
	 * What to do when a named artifact is missing in build mode.
	 * - `'error'` (default): fail the build.
	 * - `'warn'`: log and keep building (useful for CI bootstrap before captures exist).
	 */
	fail?: 'error' | 'warn';
	/**
	 * Chain `.precompile('<prefix>-<slug>-<n>')` onto every `new *NodeMaterial(...)`
	 * automatically. Artifact names become positional; reordering source reshuffles them.
	 * Default: `false`.
	 */
	autoMark?: boolean;
	/** Prefix used by `autoMark` to name artifacts. Default: `'auto'`. */
	autoMarkPrefix?: string;
	/**
	 * Alias `three/webgpu` to the slim runtime bundle (no TSL builder).
	 * Requires every reachable material to be precompiled. Default: `false`.
	 */
	slim?: boolean;
	/** Override the auto-detected three.js version used in rewrite hashes. Pass `null` to force auto-detect. */
	threeVersion?: string | null;
	/**
	 * Compact WGSL in emitted virtual modules; captured JSON stays readable.
	 * Default: `true`.
	 */
	minifyWgsl?: boolean;
	/**
	 * Hoist repeated WGSL strings into a tree-shakeable shared pool.
	 * Default: `true`.
	 */
	dedupeWgsl?: boolean;
}

/**
 * Vite plugin that AOT-compiles three.js TSL materials marked with `.precompile(name)`.
 *
 * In dev: attaches a capture endpoint so `.precompile()` calls from the runtime marker
 * write artifacts to disk. In build: rewrites every `.precompile('name')` call site into
 * `__applyPrecompiled(...)` with an injected import of `virtual:tsl-precompile/<name>`.
 */
export default function tslPrecompile( options?: TslPrecompileOptions ): Plugin;
