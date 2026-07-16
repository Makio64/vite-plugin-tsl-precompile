/**
 * Canonical material-shape vocabulary for artifacts owned by renderer or
 * post-processing infrastructure rather than an authored user material.
 * Capture, codegen, and replay must agree on this classification because an
 * auxiliary payload is keyed by `shape + configHash`, not by a user marker's
 * `name + hash` identity.
 */

export const POSTPROCESS_EFFECT_AUXILIARY_SHAPES = Object.freeze( [
	'bloom-high-pass',
	'bloom-composite',
	'bloom-blur-0',
	'bloom-blur-1',
	'bloom-blur-2',
	'bloom-blur-3',
	'bloom-blur-4',
	'gtao',
	'sss',
	'outline-depth',
	'outline-depth-sprite',
	'outline-mask',
	'outline-mask-sprite',
	'outline-edge',
	'outline-blur',
	'outline-composite',
	'ssr-trace',
	'ssr-blur',
	'ssr-copy',
	'dof-coc',
	'dof-coc-blurred',
	'dof-blur-64',
	'dof-blur-16',
	'dof-composite',
	'traa-resolve',
] );

export const AUXILIARY_MATERIAL_SHAPES = Object.freeze( [
	'background',
	'post-process',
	'pmrem',
	'lights',
	'shadow-depth',
	'render-pipeline',
	'output-transform',
	'pmrem-cubemap',
	'pmrem-equirect',
	'pmrem-blur',
	'pmrem-ggx',
	'mrt',
	'backdrop',
	'render-output',
	'cube-render-target',
	...POSTPROCESS_EFFECT_AUXILIARY_SHAPES,
] );

const AUXILIARY_MATERIAL_SHAPE_SET = new Set( AUXILIARY_MATERIAL_SHAPES );

export function isAuxiliaryMaterialShape( value ) {

	return typeof value === 'string' && AUXILIARY_MATERIAL_SHAPE_SET.has( value );

}
