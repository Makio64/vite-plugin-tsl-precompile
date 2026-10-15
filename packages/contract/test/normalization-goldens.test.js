import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeMaterialGraph, normalizeRenderContextSignature } from '@tsl-precompile/contract/graph-normalize';

import { MATERIAL_GRAPH_CASES, RENDER_CONTEXT_SIGNATURE_CASES } from './fixtures/normalization-goldens.js';

// These bytes are the staleness contract. When one of these strings changes,
// every committed artifact whose material matches that shape changes staleness
// state in every consuming project. That is sometimes correct — but it must be
// a decision someone made and reviewed, not a side effect of a refactor.
//
// If a case here fails: regenerate with
//   node packages/contract/test/fixtures/normalization-goldens.js --write
// and put the resulting diff in the change description.

const GOLDEN = JSON.parse( readFileSync(
	resolve( dirname( fileURLToPath( import.meta.url ) ), 'fixtures/normalization-goldens.json' ),
	'utf8',
) );

test( 'the golden file declares its schema', () => {

	assert.equal( GOLDEN.schema, 'tslp-normalization-golden@1' );

} );

test( 'every declared case has a pinned golden and vice versa', () => {

	assert.deepEqual(
		Object.keys( GOLDEN.materialGraphs ).sort(),
		MATERIAL_GRAPH_CASES.map( ( item ) => item.name ).sort(),
		'a case without a golden is untested; a golden without a case is dead',
	);
	assert.deepEqual(
		Object.keys( GOLDEN.renderContextSignatures ).sort(),
		RENDER_CONTEXT_SIGNATURE_CASES.map( ( item ) => item.name ).sort(),
	);

} );

for ( const item of MATERIAL_GRAPH_CASES ) {

	test( `material graph golden: ${ item.name }`, () => {

		assert.equal( normalizeMaterialGraph( item.material ), GOLDEN.materialGraphs[ item.name ] );

	} );

}

for ( const item of RENDER_CONTEXT_SIGNATURE_CASES ) {

	test( `render-context signature golden: ${ item.name }`, () => {

		assert.equal( normalizeRenderContextSignature( item.signature ), GOLDEN.renderContextSignatures[ item.name ] );

	} );

}

test( 'the goldens distinguish the cases they are meant to distinguish', () => {

	const values = Object.values( GOLDEN.materialGraphs );
	assert.equal( new Set( values ).size, values.length, 'two fixtures collapsing to one string means one of them stopped being tested' );

} );

test( 'normalization is a pure function of its input', () => {

	for ( const item of MATERIAL_GRAPH_CASES ) {

		assert.equal(
			normalizeMaterialGraph( item.material ),
			normalizeMaterialGraph( item.material ),
			`${ item.name } must not depend on call order or cached state`,
		);

	}

} );

test( 'auxiliary v1 payload bytes retain legacy config encoding and node shape', async () => {

	const { createNodeGraphHashPayload, createPlainConfigHashPayload } = await import( '@tsl-precompile/contract/graph-normalize' );
	const options = { shape: 'pmrem', threeVersion: '0.184.0', pluginVersion: '0.1.0' };
	assert.equal(
		createPlainConfigHashPayload( { z: undefined, a: [ undefined, NaN, { b: 2, a: 1 } ] }, options ),
		'plain-v1\npmrem\n0.184.0\n0.1.0\n{"a":[,null,{"a":1,"b":2}],"z":undefined}',
	);
	assert.equal( createNodeGraphHashPayload( null, options ), 'node-v1\npmrem\n0.184.0\n0.1.0\nnull' );

} );
