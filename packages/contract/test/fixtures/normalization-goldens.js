// Pinned normalization inputs.
//
// Unit tests state *rules* ("a uniform write must not change the fingerprint").
// Goldens state *bytes*. They exist because a change to the normalizer is
// almost never announced as a behavior change — it arrives as a refactor, and
// the only visible symptom downstream is that every committed artifact in every
// consuming project silently becomes stale, or silently stops becoming stale.
//
// The golden file is regenerated with:
//   node packages/contract/test/fixtures/normalization-goldens.js --write
//
// Regenerating is fine. Regenerating *without reading the diff* is the thing
// this guards against: the diff is the review artifact.

export const MATERIAL_GRAPH_CASES = Object.freeze( [
	{
		name: 'bare material',
		material: {},
	},
	{
		name: 'pipeline state flags',
		material: {
			transparent: true,
			depthWrite: false,
			side: 2,
			blending: 5,
			polygonOffset: true,
			polygonOffsetFactor: 2,
			polygonOffsetUnits: 1,
		},
	},
	{
		name: 'positive-feature buckets',
		material: { transmission: 0.4, clearcoat: 0, iridescence: 1.5, alphaTest: 0.5 },
	},
	{
		name: 'uniform node with a live value',
		material: { colorNode: { isNode: true, isUniformNode: true, value: 0.5, nodeType: 'float' } },
	},
	{
		name: 'const node folded into the shader',
		material: { colorNode: { isNode: true, isConstNode: true, value: 0.5, nodeType: 'float' } },
	},
	{
		name: 'texture node topology',
		material: {
			colorNode: {
				isNode: true,
				isTextureNode: true,
				value: { isTexture: true, format: 1023, type: 1009, colorSpace: 'srgb', mapping: 300, channel: 0 },
			},
		},
	},
	{
		name: 'nested node tree with structural children',
		material: {
			colorNode: {
				isNode: true,
				operator: 'mul',
				aNode: { isNode: true, _attributeName: 'uv' },
				bNode: { isNode: true, isUniformNode: true, value: 2, nodeType: 'vec3' },
				options: { premultiply: true, order: [ 1, 2, 3 ] },
			},
		},
	},
	{
		name: 'typed-array payload',
		material: { positionNode: { isNode: true, array: new Float32Array( [ 1, 2, 3, 4 ] ) } },
	},
] );

export const RENDER_CONTEXT_SIGNATURE_CASES = Object.freeze( [
	{ name: 'empty', signature: '' },
	{ name: 'pre-hashed string', signature: 'sha256:abcdef' },
	{ name: 'unsorted object', signature: { zeta: 1, alpha: { y: 2, x: 1 }, beta: [ 3, 1, 2 ] } },
] );

// Rebuild the golden file when run directly.
if ( process.argv[ 1 ] && process.argv[ 1 ].endsWith( 'normalization-goldens.js' ) && process.argv.includes( '--write' ) ) {

	const { writeFileSync } = await import( 'node:fs' );
	const { fileURLToPath } = await import( 'node:url' );
	const { resolve, dirname } = await import( 'node:path' );
	const { normalizeMaterialGraph, normalizeRenderContextSignature } = await import( '../../src/graph-normalize.js' );
	const here = dirname( fileURLToPath( import.meta.url ) );
	const golden = {
		schema: 'tslp-normalization-golden@1',
		materialGraphs: Object.fromEntries( MATERIAL_GRAPH_CASES.map( ( item ) => [ item.name, normalizeMaterialGraph( item.material ) ] ) ),
		renderContextSignatures: Object.fromEntries( RENDER_CONTEXT_SIGNATURE_CASES.map( ( item ) => [ item.name, normalizeRenderContextSignature( item.signature ) ] ) ),
	};
	writeFileSync( resolve( here, 'normalization-goldens.json' ), `${ JSON.stringify( golden, null, '\t' ) }\n` );
	console.log( `Wrote ${ MATERIAL_GRAPH_CASES.length } material and ${ RENDER_CONTEXT_SIGNATURE_CASES.length } signature goldens. Read the diff before committing.` );

}
