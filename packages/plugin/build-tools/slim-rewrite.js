/**
 * Build-only boundary consumed by @tsl-precompile/runtime's checked slim
 * bundle recipe.
 *
 * Keep this entry deliberately narrow. The Vite plugin owns Three source
 * rewrite policy; the runtime build may consume the two operations needed to
 * apply that policy without reaching through a monorepo-relative src path.
 */
export {
	getSlimRewriteRuntimeModuleRule,
	rewriteThreeSource,
} from '../src/three-rewrite.js';
