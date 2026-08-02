import { resolve } from 'node:path';

import {
	INTERNAL_PASS_FAMILY_REQUIREMENTS,
	INTERNAL_PASS_STAGES,
	internalPassShape,
} from '@tsl-precompile/contract/internal-pass';
import { discoverLocalExampleCases } from '../../../examples/batch/local-example-discovery.mjs';

function internalPassFamilyShapes( family ) {

	return INTERNAL_PASS_STAGES[ family ].map( ( stage ) => internalPassShape( family, stage ) );

}

const EXAMPLE_SPECS = [
	{
		name: 'getting-started',
		filter: 'examples-getting-started',
		paths: [ '/' ],
		sources: [ 'main.js' ],
		mode: 'tslp-site-live',
		// This is the docs site's pure-slim canary. Capture both renderer
		// backends so the same generated site route works on WebGPU-capable
		// browsers and on WebGPURenderer's WebGL fallback.
		backends: [ 'webgpu', 'webgl' ],
		productionPreviewRoutes: [
			{
				path: '/',
				receiptId: 'getting-started',
				requestedBackend: 'webgpu',
				domain: { type: 'canary', backend: 'webgpu' },
			},
			{
				path: '/',
				receiptId: 'getting-started',
				requestedBackend: 'webgl',
				domain: { type: 'canary', backend: 'webgl' },
			},
		],
	},
	{
		name: 'ocean',
		filter: 'examples-ocean',
		paths: [ '/' ],
		sources: [ 'main.js' ],
		// The PMREM sky capture can finish near the default 10s boundary on
		// software WebGPU runners. Keep the route bounded without grading a
		// valid final POST as an empty capture because of scheduler jitter.
		timeout: 60_000,
	},
	{ name: 'pbr-shadows', filter: 'examples-pbr-shadows', paths: [ '/' ], sources: [ 'main.js' ] },
	{
		name: 'shadow-debug',
		filter: 'examples-shadow-debug',
		cases: 'packages/examples/shadow-debug/e2e-cases.json',
		sources: [ 'src' ],
		autoMark: false,
		timeout: 60000,
		requiredAuxiliaryShapes: [
			...INTERNAL_PASS_FAMILY_REQUIREMENTS[ 'shadow-vsm' ].requiredAuxiliaryShapes,
			...internalPassFamilyShapes( 'shadow-vsm' ),
		],
		productionPreviewRoutes: [
			{
				path: '/vsm.html',
				receiptId: 'shadow-debug:vsm.html',
				domain: { type: 'vsm', lightKind: 'directional' },
			},
			{
				path: '/spot.html?shadow=vsm',
				receiptId: 'shadow-debug:spot.html?shadow=vsm',
				domain: { type: 'vsm', lightKind: 'spot' },
			},
		],
	},
	{
		name: 'postprocessing-debug',
		filter: 'examples-postprocessing-debug',
		cases: 'packages/examples/postprocessing-debug/e2e-cases.json',
		sources: [ 'src' ],
		autoMark: false,
		// variants.html intentionally renders each authored material topology
		// before capturing two post-process pipelines. The default 10s CLI
		// timeout can abort that valid in-page 30s settlement window on loaded
		// CI hosts, leaving the later variants stale.
		timeout: 60_000,
	},
	{
		name: 'pmrem-debug',
		filter: 'examples-pmrem-debug',
		cases: 'packages/examples/pmrem-debug/e2e-cases.json',
		sources: [ 'src' ],
		timeout: 60000,
		requiredAuxiliaryShapes: internalPassFamilyShapes( 'pmrem' ),
		productionPreviewRoutes: [
			{
				path: '/equirect.html',
				receiptId: 'pmrem-debug:equirect.html',
				domain: { type: 'pmrem', mode: 'equirect' },
			},
			{
				path: '/cubemap.html',
				receiptId: 'pmrem-debug:cubemap.html',
				domain: { type: 'pmrem', mode: 'cubemap' },
			},
			{
				path: '/from-scene.html',
				receiptId: 'pmrem-debug:from-scene.html',
				domain: { type: 'pmrem', mode: 'from-scene' },
			},
			{
				path: '/transmission.html',
				receiptId: 'pmrem-debug:transmission.html',
				domain: { type: 'pmrem', mode: 'transmission' },
			},
		],
	},
	{
		name: 'mrt-debug',
		filter: 'examples-mrt-debug',
		cases: 'packages/examples/mrt-debug/e2e-cases.json',
		sources: [ 'src' ],
		autoMark: false,
	},
	{ name: 'background', filter: 'examples-background', paths: [ '/' ], sources: [ 'main.js' ] },
	{
		name: 'compute-debug',
		filter: 'examples-compute-debug',
		cases: 'packages/examples/compute-debug/e2e-cases.json',
		sources: [ 'src' ],
	},
	{
		name: 'wow-showcase',
		filter: 'examples-wow-showcase',
		sources: [ 'src' ],
		autoMark: false,
		paths: [
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
		timeout: 45000,
	},
];

function normalizeRoute( route, source ) {

	if ( typeof route !== 'string' || route.trim() === '' ) {

		throw new Error( `Invalid recapture route in ${ source }` );

	}

	const normalized = `/${ route.trim().replace( /^\/+/, '' ) }`;
	if ( normalized.includes( ',' ) ) {

		throw new Error( `Recapture route cannot contain a comma: ${ normalized } (${ source })` );

	}

	return normalized;

}

export function createRecapturePlan( repoRoot ) {

	return EXAMPLE_SPECS.map( ( spec ) => ( {
		name: spec.name,
		filter: spec.filter,
		sourceRoot: `packages/examples/${ spec.name }`,
		sources: spec.sources.map( ( source ) => `packages/examples/${ spec.name }/${ source }` ),
		autoMark: spec.autoMark !== false,
		paths: spec.cases
			? discoverLocalExampleCases( resolve( repoRoot, 'packages/examples', spec.name ) )
				.map( ( entry ) => normalizeRoute( entry.path, spec.cases ) )
			: spec.paths.map( ( route ) => normalizeRoute( route, spec.name ) ),
		backends: [ ...( spec.backends || [] ) ],
		...( spec.mode ? { mode: spec.mode } : {} ),
			requiredAuxiliaryShapes: [ ...( spec.requiredAuxiliaryShapes || [] ) ],
		productionPreviewRoutes: ( spec.productionPreviewRoutes || [] ).map( ( route ) => ( {
				path: normalizeRoute( route.path, `${ spec.name } production preview` ),
				receiptId: route.receiptId,
				domain: { ...route.domain },
				...( route.requestedBackend ? { requestedBackend: route.requestedBackend } : {} ),
			} ) ),
			...( spec.timeout ? { timeout: spec.timeout } : {} ),
		} ) );

}
