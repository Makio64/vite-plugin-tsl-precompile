/// <reference path="./virtual-modules.d.ts" />

import type { Plugin } from 'vite';

export interface TslPrecompileOptions {
	/** Where captured artifacts live on disk. Default: `'./artifacts'`. */
	artifactsDir?: string;
	/**
	 * What to do when a named artifact is missing in build mode.
	 * - `'error'` (default): fail the build.
	 * - `'warn'`: in full-Three compatibility mode, log and keep the live
	 *   material while continuing to rewrite captured markers in the module.
	 *   Compiler-free slim modes reject warning recovery.
	 */
	fail?: 'error' | 'warn';
	/**
	 * Chain `.precompile('<prefix>-<slug>-<module-hash>-<n>')` onto every `new *NodeMaterial(...)`
	 * automatically. Framework script subresources get distinct module hashes; the final
	 * per-module ordinal remains positional, so reordering constructors can reshuffle it.
	 * Enabled by default. Set to `false` to require explicit markers.
	 */
	autoMark?: boolean;
	/** Prefix used by `autoMark` to name artifacts. Default: `'auto'`. */
	autoMarkPrefix?: string;
	/**
	 * Alias `three/webgpu` to a compiler-free runtime in production builds.
	 * `'source'` is recommended for new Vite apps and lets the application
	 * bundler tree-shake exact Three source modules; `true` uses the checked
	 * single-file prebuilt bundle. Serve/dev keeps full Three for capture.
	 * Requires every reachable path to be precompiled or explicitly supported.
	 * Default: `false`.
	 */
	slim?: boolean | 'source';
	/** Override the auto-detected exact three.js package version used in rewrite hashes. Must match the installed package (for example `0.185.1`). Pass `null` to force auto-detect. */
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
