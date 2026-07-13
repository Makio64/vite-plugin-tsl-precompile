/// <reference path="./virtual-modules.d.ts" />

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
	 * Chain `.precompile('<prefix>-<slug>-<module-hash>-<n>')` onto every `new *NodeMaterial(...)`
	 * automatically. Framework script subresources get distinct module hashes; the final
	 * per-module ordinal remains positional, so reordering constructors can reshuffle it.
	 * Default: `false`.
	 */
	autoMark?: boolean;
	/** Prefix used by `autoMark` to name artifacts. Default: `'auto'`. */
	autoMarkPrefix?: string;
	/**
	 * Alias `three/webgpu` to a compiler-free runtime in production builds.
	 * `true` uses the checked prebuilt bundle; `'source'` lets the application
	 * bundler tree-shake exact Three source modules. Serve/dev keeps full Three
	 * for capture. Requires every reachable material to be precompiled.
	 * Default: `false`.
	 */
	slim?: boolean | 'source';
	/** Override the auto-detected exact three.js package version used in rewrite hashes. Must match the installed package (for example `0.184.0`). Pass `null` to force auto-detect. */
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
