import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { selectRecaptureExamples } from '../../src/cli/recapture-all-support.js';
import { createRecapturePlan } from '../../src/cli/recapture-plan.js';

const REPO = resolve( import.meta.dirname, '../../../..' );

test( 'recapture-all covers every artifact-producing example route', () => {

	const plan = createRecapturePlan( REPO );
	const routesByExample = Object.fromEntries(
		plan.map( ( example ) => [ example.name, example.paths ] ),
	);

	assert.deepEqual( routesByExample, {
		'getting-started': [ '/' ],
		ocean: [ '/' ],
		'pbr-shadows': [ '/' ],
		'shadow-debug': [
			'/directional.html?shadow=basic',
			'/directional.html?shadow=pcf',
			'/directional.html?shadow=pcf-soft',
			'/directional.html?shadow=vsm',
			'/spot.html?shadow=basic',
			'/spot.html?shadow=pcf',
			'/spot.html?shadow=pcf-soft',
			'/spot.html?shadow=vsm',
			'/point.html?shadow=basic',
				'/point.html?shadow=pcf',
				'/point.html?shadow=pcf-soft',
				'/point.html?shadow=vsm',
				'/directional.html',
				'/point.html',
				'/spot.html',
				'/vsm.html',
			],
		'postprocessing-debug': [
			'/passthrough.html',
			'/bloom.html',
			'/fxaa.html',
			'/gtao.html',
			'/variants.html',
		],
		'pmrem-debug': [
			'/equirect.html',
			'/cubemap.html',
			'/from-scene.html',
			'/transmission.html',
		],
		'mrt-debug': [
			'/pass.html',
			'/mask.html',
			'/manual.html',
		],
		background: [ '/' ],
		'compute-debug': [
			'/particles.html',
			'/instanced.html',
			'/texture.html',
			'/dispatch2d.html',
			'/uniform.html',
			'/pipeline.html',
			'/reduce.html',
		],
		'wow-showcase': [
			'/race.html',
			'/tool.html',
			'/women.html',
			'/robots.html',
			'/abyss.html',
			'/orbit.html',
			'/pulse.html',
			'/climate.html',
			'/fashion.html',
			'/architecture.html',
		],
	} );
	assert.equal(
		plan.reduce( ( count, example ) => count + example.paths.length, 0 ),
			49,
	);
	assert.deepEqual(
		routesByExample[ 'shadow-debug' ].slice( - 4 ),
		[ '/directional.html', '/point.html', '/spot.html', '/vsm.html' ],
		'the compiler-free direct VSM build entry is a mandatory recapture route',
	);
	assert.deepEqual(
		plan.find( ( example ) => example.name === 'shadow-debug' ).requiredAuxiliaryShapes,
		[ 'shadow-depth', 'shadow-vsm-vertical', 'shadow-vsm-horizontal' ],
	);
	assert.deepEqual(
		plan.find( ( example ) => example.name === 'pmrem-debug' ).requiredAuxiliaryShapes,
		[ 'pmrem-cubemap', 'pmrem-equirect', 'pmrem-blur', 'pmrem-ggx' ],
	);
	assert.deepEqual(
		plan.find( ( example ) => example.name === 'getting-started' ).backends,
		[ 'webgpu', 'webgl' ],
		'the docs-site slim canary is recaptured for both WebGPURenderer backends',
	);
	assert.equal(
		plan.find( ( example ) => example.name === 'getting-started' ).mode,
		'tslp-site-live',
		'the canary capture enables the same renderer-output contract used by the site build',
	);
	assert.deepEqual(
		plan
			.filter( ( example ) => example.name !== 'getting-started' )
			.flatMap( ( example ) => example.backends ),
		[],
		'backend matrices stay opt-in for examples that cannot run on WebGL',
	);
	assert.deepEqual(
		plan.find( ( example ) => example.name === 'getting-started' ).productionPreviewRoutes,
		[
			{
				path: '/',
				receiptId: 'getting-started',
				domain: { type: 'canary', backend: 'webgpu' },
				requestedBackend: 'webgpu',
			},
			{
				path: '/',
				receiptId: 'getting-started',
				domain: { type: 'canary', backend: 'webgl' },
				requestedBackend: 'webgl',
			},
		],
	);
	assert.deepEqual(
		plan
			.filter( ( example ) => example.name !== 'getting-started' )
			.flatMap( ( example ) => example.productionPreviewRoutes ),
		[],
		'unrelated recapture examples remain build-only',
	);

} );

test( 'recapture-all artifact outputs remain visible to Git', () => {

	for ( const example of createRecapturePlan( REPO ) ) {

		const candidate = `packages/examples/${ example.name }/artifacts/recapture-output.json`;
		const result = spawnSync(
			'git',
			[ 'check-ignore', '--no-index', '--quiet', candidate ],
			{ cwd: REPO, encoding: 'utf8' },
		);

		assert.equal(
			result.status,
			1,
			result.error
				? `could not check Git visibility for ${ candidate }: ${ result.error.message }`
				: `${ candidate } is ignored; a recapture could update its manifest without committing the referenced artifact`,
		);

	}

} );

test( 'long-running recapture subsets carry explicit bounded timeouts', () => {

	const plan = createRecapturePlan( REPO );
	const selection = selectRecaptureExamples( plan, [ '--example', 'pmrem-debug' ] );
	const postprocessing = selectRecaptureExamples( plan, [ '--example', 'postprocessing-debug' ] );

	assert.equal( selection.examples.length, 1 );
	assert.equal( selection.examples[ 0 ].name, 'pmrem-debug' );
	assert.equal( selection.examples[ 0 ].timeout, 60000 );
	assert.equal( postprocessing.examples.length, 1 );
	assert.equal( postprocessing.examples[ 0 ].timeout, 60000 );
	assert.deepEqual(
		plan
			.filter( ( example ) => Object.hasOwn( example, 'timeout' ) )
			.map( ( example ) => [ example.name, example.timeout ] ),
		[
			[ 'shadow-debug', 60000 ],
			[ 'postprocessing-debug', 60000 ],
			[ 'pmrem-debug', 60000 ],
			[ 'wow-showcase', 45000 ],
		],
	);


} );
