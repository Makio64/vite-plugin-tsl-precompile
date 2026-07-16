import test from 'node:test';
import assert from 'node:assert/strict';

import {
	installPrecompileMarker,
	setDevRenderer,
	clearDevRenderer,
	__resetForTests,
	__createCaptureObjectForTests,
} from '../src/precompile-marker.js';
import { __resetRegistry, getArtifact } from '../src/artifact-loader.js';
import { hashArtifactContentSync } from '../src/graph-hash.js';
import { takeRenderObjectHarvest } from '../src/auxiliary/render-object-harvest-handoff.js';
import { beginRenderObjectHarvest } from '../../plugin/src/vendor/render-object-observer.js';
import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayload,
	mergeArtifactVariantFamily,
} from '@tsl-precompile/contract/artifact-variants';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

test( 'capture clones retain BatchedMesh runtime textures', () => {

	class Mesh {}
	class BoxGeometry {}
	const matricesTexture = { name: 'matrices' };
	const colorsTexture = { name: 'colors' };
	const cloned = { children: [ {} ], parent: {} };
	const source = {
		material: {},
		_matricesTexture: matricesTexture,
		_colorsTexture: colorsTexture,
		count: 512,
		clone() {

			return cloned;

		},
	};
	const captureObject = __createCaptureObjectForTests( Mesh, BoxGeometry, source, {} );

	assert.equal( captureObject, cloned );
	assert.equal( captureObject._matricesTexture, matricesTexture );
	assert.equal( captureObject._colorsTexture, colorsTexture );
	assert.equal( captureObject.count, 512 );
	assert.deepEqual( captureObject.children, [] );
	assert.equal( captureObject.parent, null );

} );

test( 'detached helper capture clones use the base matrix updater', () => {

	class Mesh {

		updateMatrixWorld() {

			this.baseUpdaterCalled = true;

		}

	}
	class BoxGeometry {}
	const cloned = {
		children: [ { material: {} } ],
		updateMatrixWorld() {

			this.children[ 0 ].material.needsUpdate = true;

		},
	};
	const source = {
		isHelper: true,
		type: 'RectAreaLightHelper',
		material: {},
		clone() {

			return cloned;

		},
	};
	const captureObject = __createCaptureObjectForTests( Mesh, BoxGeometry, source, {} );

	assert.doesNotThrow( () => captureObject.updateMatrixWorld() );
	assert.equal( captureObject.baseUpdaterCalled, true );
	assert.deepEqual( captureObject.children, [] );

} );

function makeThree( prefix = 'fixture' ) {

	let nextUuid = 1;
	class Material {

		constructor() {

			this.uuid = `${ prefix }-material-${ nextUuid ++ }`;
			this.type = 'MeshStandardNodeMaterial';
			this.name = '';

		}

	}
	class Scene {

		constructor() {

			this.isScene = true;
			this.type = 'Scene';
			this.userData = {};
			this.children = [];

		}

		add( object ) {

			this.children.push( object );
			object.parent = this;

		}

		traverse( visitor ) {

			visitor( this );
			for ( const child of this.children ) visitor( child );

		}

		updateMatrixWorld() {}

	}
	class Mesh {

		constructor( geometry, material ) {

			this.type = 'Mesh';
			this.geometry = geometry;
			this.material = material;
			this.children = [];
			this.parent = null;
			this.visible = true;
			this.layers = { mask: 1, test: () => true };
			this.position = { x: 0, y: 0, z: 0 };
			this.scale = { x: 1, y: 1, z: 1 };

		}

	}
	class PerspectiveCamera {

		constructor() {

			this.type = 'PerspectiveCamera';
			this.isPerspectiveCamera = true;
			this.position = { set() {} };
			this.layers = { mask: 1, test: () => true };

		}

		clone() { return new PerspectiveCamera(); }
		lookAt() {}
		updateProjectionMatrix() {}
		updateMatrixWorld() {}

	}
	class ArrayCamera {

		constructor( cameras = [ new PerspectiveCamera() ] ) {

			this.type = 'ArrayCamera';
			this.isArrayCamera = true;
			this.cameras = cameras;
			this.position = { copy() {} };
			this.quaternion = { copy() {} };
			this.layers = { mask: 1, test: () => true };

		}

		updateMatrixWorld() {}

	}
	class BoxGeometry {

		constructor() {

			this.type = 'BoxGeometry';
			this.attributes = {};
			this.morphAttributes = {};

		}

	}
	class Color {}

	return { Material, Scene, Mesh, PerspectiveCamera, ArrayCamera, BoxGeometry, Color, REVISION: '184' };

}

function mount( three, material, ObjectClass = three.Mesh ) {

	const scene = new three.Scene();
	const object = new ObjectClass( new three.BoxGeometry(), material );
	const camera = new three.PerspectiveCamera();
	scene.add( object );
	return { scene, object, camera };

}

function artifactSet( material ) {

	const artifact = {
		version: 3,
		cacheKey: `cache-${ material.uuid }`,
		materialUuid: material.uuid,
		materialShape: 'mesh-standard',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [],
		uniformPlan: [],
		attributes: [],
		nodeAttributes: [],
	};
	const result = [ artifact ];
	result.byMaterialUuid = new Map( [ [ material.uuid, artifact ] ] );
	result.byMaterialVariants = new Map( [ [ material.uuid, [ artifact ] ] ] );
	return result;

}

async function waitFor( predicate, label = 'condition' ) {

	for ( let i = 0; i < 100; i ++ ) {

		if ( predicate() ) return;
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

	}
	assert.fail( `timed out waiting for ${ label }` );

}

async function withBrowser( run, { worker = false } = {} ) {

	__resetForTests();
	__resetRegistry();
	const saved = {
		window: globalThis.window,
		self: globalThis.self,
		WorkerGlobalScope: globalThis.WorkerGlobalScope,
		fetch: globalThis.fetch,
		version: globalThis.__TSLP_THREE_PACKAGE_VERSION__,
		autoFallbackDelay: globalThis.__TSLP_AUTO_FALLBACK_DELAY_MS__,
	};
	const posts = [];
	if ( worker ) {

		delete globalThis.window;
		class FakeWorkerGlobalScope {}
		globalThis.WorkerGlobalScope = FakeWorkerGlobalScope;
		globalThis.self = new FakeWorkerGlobalScope();

	} else {

		globalThis.window = globalThis;

	}
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '0.184.0';
	globalThis.fetch = async ( _url, init ) => {

		const posted = JSON.parse( init.body );
		posts.push( posted );
		return {
			ok: true,
			json: async () => ( { ok: true, name: posted.name, hash: posted.hash, artifact: posted.artifact } ),
			text: async () => 'ok',
		};

	};

	try {

		await run( posts );

	} finally {

		clearDevRenderer();
		__resetForTests();
		__resetRegistry();
		for ( const [ key, value ] of Object.entries( saved ) ) {

			const globalKey = key === 'version'
				? '__TSLP_THREE_PACKAGE_VERSION__'
				: key === 'autoFallbackDelay' ? '__TSLP_AUTO_FALLBACK_DELAY_MS__' : key;
			if ( value === undefined ) delete globalThis[ globalKey ];
			else globalThis[ globalKey ] = value;

		}

	}

}

test( 'accepted recaptures replace the live inspector artifact', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'accepted-recapture' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let revision = 0;
		install( three, async () => {

			const artifacts = artifactSet( material );
			artifacts[ 0 ].fragmentShader = `fragment-${ ++ revision }`;
			return artifacts;

		} );
		setDevRenderer( renderer, three );

		material.precompile( 'live-recapture', context );
		await waitFor( () => posts.length === 1 && getArtifact( 'live-recapture' )?.__hash === posts[ 0 ].hash, 'first live artifact' );
		const firstHash = posts[ 0 ].hash;

		material.precompile( 'live-recapture', context );
		await waitFor( () => posts.length === 2 && getArtifact( 'live-recapture' )?.__hash === posts[ 1 ].hash, 'replacement live artifact' );
		assert.notEqual( posts[ 1 ].hash, firstHash );

	} );

} );

test( 'material capture omits enumerable private sidecars without mutating the extracted artifact', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'private-sidecar-serializer' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let extractedArtifact = null;
		const liveArray = [ 1, 2, 3 ];
		const liveAttribute = { array: liveArray };
		install( three, async () => {

			const artifacts = artifactSet( material );
			extractedArtifact = artifacts[ 0 ];
			extractedArtifact.__hash = 'extractor-envelope-hash';
			extractedArtifact.__name = 'private-sidecar-material';
			extractedArtifact._liveArray = liveArray;
			extractedArtifact.uniformPlan.push( {
				storageBuffers: [ { count: 3, _liveAttribute: liveAttribute } ],
			} );
			return artifacts;

		} );
		setDevRenderer( renderer, three );

		material.precompile( 'private-sidecar-material', context );
		await waitFor( () => posts.length === 1, 'private-sidecar material capture' );

		assert.equal( posts[ 0 ].artifact.__hash, 'extractor-envelope-hash' );
		assert.equal( posts[ 0 ].artifact.__name, 'private-sidecar-material' );
		assert.equal( posts[ 0 ].artifact._liveArray, undefined );
		assert.equal( posts[ 0 ].artifact.uniformPlan[ 0 ].storageBuffers[ 0 ]._liveAttribute, undefined );
		assert.equal( extractedArtifact._liveArray, liveArray );
		assert.equal( extractedArtifact.uniformPlan[ 0 ].storageBuffers[ 0 ]._liveAttribute, liveAttribute );

	} );

} );

test( 'distinct same-callsite instances publish the server-accepted aggregate', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'aggregate-instances' );
		const first = new three.Material();
		const second = new three.Material();
		const firstContext = mount( three, first );
		const secondContext = mount( three, second );
		const renderer = { render() {} };
		install( three, async ( _renderer, scene ) => {

			let captured = null;
			scene.traverse( ( object ) => {

				if ( object.material ) captured = object.material;

			} );
			return artifactSet( captured );

		} );
		setDevRenderer( renderer, three );
		globalThis.fetch = async ( _url, init ) => {

			const posted = JSON.parse( init.body );
			posts.push( posted );
			const acceptedArtifact = posts.length === 2
				? { ...posted.artifact, serverAggregate: { members: 2 } }
				: posted.artifact;
			const acceptedHash = hashArtifactContentSync( acceptedArtifact, {
				shape: `material:${ posted.name }`,
				threeVersion: acceptedArtifact.sourceThreeVersion,
				pluginVersion: acceptedArtifact.sourceHashVersion,
			} );
			return {
				ok: true,
				json: async () => ( { ok: true, name: posted.name, hash: acceptedHash, artifact: acceptedArtifact } ),
			};

		};
		const revision = 'a'.repeat( 64 );
		first.precompile( 'shared-callsite', firstContext, 'src/materials.js:1:0', revision );
		second.precompile( 'shared-callsite', secondContext, 'src/materials.js:1:0', revision );

		await waitFor( () => posts.length === 2 && getArtifact( 'shared-callsite' )?.artifact?.serverAggregate?.members === 2, 'server aggregate publication' );
		assert.deepEqual( posts.map( ( post ) => post.sourceIdentity ), [ 'src/materials.js:1:0', 'src/materials.js:1:0' ] );
		assert.deepEqual( posts.map( ( post ) => post.sourceRevision ), [ revision, revision ] );

	} );

} );

test( 'represented extractor roots publish and adopt the canonical accepted family', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'represented-family' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
		const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
		const selectorC = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-cube' } } );
		const selectorD = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default', sampleCount: 4 } } );
		const makeVariant = ( cacheKey, shader, selectors ) => ( {
			version: 3,
			cacheKey,
			materialUuid: material.uuid,
			materialShape: 'mesh-standard',
			renderContextSelectors: selectors,
			vertexShader: `vertex:${ shader }`,
			fragmentShader: `fragment:${ shader }`,
			bindings: [],
			uniformPlan: [],
			attributes: [],
			nodeAttributes: [],
		} );
		const canonical = makeVariant( 'a-canonical', 'shared-root', [ selectorA, selectorB ] );
		const sibling = makeVariant( 'm-extractor-sibling', 'extractor-sibling', [ selectorC ] );
		const root = makeVariant( 'z-extractor-root', 'shared-root', [ selectorA ] );
		root.variants = {
			'z-extractor-root': createArtifactVariantPayload( root ),
			'm-extractor-sibling': createArtifactVariantPayload( sibling ),
			'a-canonical': createArtifactVariantPayload( canonical ),
		};
		const artifactFamily = [ root, canonical, sibling ];
		artifactFamily.byMaterialUuid = new Map( [ [ material.uuid, root ] ] );
		artifactFamily.byMaterialVariants = new Map( [ [ material.uuid, [ root, sibling, canonical ] ] ] );
		install( three, async () => artifactFamily );
		setDevRenderer( renderer, three );

		globalThis.fetch = async ( _url, init ) => {

			const posted = JSON.parse( init.body );
			posts.push( posted );
			const acceptedArtifact = structuredClone( posted.artifact );
			const serverSibling = makeVariant( 'n-server-sibling', 'server-sibling', [ selectorD ] );
			mergeArtifactVariantFamily( acceptedArtifact, [ acceptedArtifact, serverSibling ] );
			const acceptedHash = hashArtifactContentSync( acceptedArtifact, {
				shape: `material:${ posted.name }`,
				threeVersion: acceptedArtifact.sourceThreeVersion,
				pluginVersion: acceptedArtifact.sourceHashVersion,
			} );
			return {
				ok: true,
				json: async () => ( { ok: true, name: posted.name, hash: acceptedHash, artifact: acceptedArtifact } ),
			};

		};

		material.precompile( 'represented-live-family', context, 'src/materials.js:represented', 'b'.repeat( 64 ) );
		await waitFor( () => collectArtifactVariantCandidates( getArtifact( 'represented-live-family' )?.artifact ).length === 3, 'accepted represented family' );

		assert.equal( posts.length, 1 );
		assert.equal( posts[ 0 ].artifact.cacheKey, 'a-canonical' );
		assert.deepEqual(
			collectArtifactVariantCandidates( posts[ 0 ].artifact ).map( ( candidate ) => candidate.cacheKey ),
			[ 'a-canonical', 'm-extractor-sibling' ],
		);
		assert.deepEqual( createArtifactVariantPayload( posts[ 0 ].artifact ), posts[ 0 ].artifact.variants[ 'a-canonical' ] );
		assert.deepEqual(
			collectArtifactVariantCandidates( getArtifact( 'represented-live-family' ).artifact ).map( ( candidate ) => candidate.cacheKey ),
			[ 'a-canonical', 'm-extractor-sibling', 'n-server-sibling' ],
			'the live registry adopts the server-returned durable aggregate',
		);

	} );

} );

test( 'an incompatible server aggregate cannot replace the accepted live artifact', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'incompatible-aggregate' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let revision = 0;
		install( three, async () => {

			const artifacts = artifactSet( material );
			artifacts[ 0 ].fragmentShader = `fragment-${ ++ revision }`;
			return artifacts;

		} );
		setDevRenderer( renderer, three );
		globalThis.fetch = async ( _url, init ) => {

			const posted = JSON.parse( init.body );
			posts.push( posted );
			const acceptedArtifact = posts.length === 2
				? { ...posted.artifact, sourceGraphHash: 'f'.repeat( 64 ) }
				: posted.artifact;
			const acceptedHash = hashArtifactContentSync( acceptedArtifact, {
				shape: `material:${ posted.name }`,
				threeVersion: acceptedArtifact.sourceThreeVersion,
				pluginVersion: acceptedArtifact.sourceHashVersion,
			} );
			return {
				ok: true,
				json: async () => ( { ok: true, name: posted.name, hash: acceptedHash, artifact: acceptedArtifact } ),
			};

		};

		material.precompile( 'incompatible-live-aggregate', context );
		await waitFor( () => posts.length === 1 && getArtifact( 'incompatible-live-aggregate' )?.__hash === posts[ 0 ].hash, 'first accepted artifact' );
		const acceptedHash = getArtifact( 'incompatible-live-aggregate' ).__hash;
		material.precompile( 'incompatible-live-aggregate', context );
		await waitFor( () => posts.length === 2, 'incompatible aggregate response' );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		assert.notEqual( posts[ 1 ].hash, acceptedHash );
		assert.equal( getArtifact( 'incompatible-live-aggregate' ).__hash, acceptedHash );

	} );

} );

test( 'rejected recaptures do not replace the live inspector artifact', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'rejected-recapture' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let revision = 0;
		let rejectedBodyRead = false;
		install( three, async () => {

			const artifacts = artifactSet( material );
			artifacts[ 0 ].fragmentShader = `fragment-${ ++ revision }`;
			return artifacts;

		} );
		setDevRenderer( renderer, three );

		material.precompile( 'rejected-live-recapture', context );
		await waitFor( () => posts.length === 1 && getArtifact( 'rejected-live-recapture' )?.__hash === posts[ 0 ].hash, 'accepted live artifact' );
		const acceptedHash = posts[ 0 ].hash;
		globalThis.fetch = async ( _url, init ) => {

			posts.push( JSON.parse( init.body ) );
			return {
				ok: false,
				status: 409,
				text: async () => {

					rejectedBodyRead = true;
					return 'source revision conflict';

				},
			};

		};
		material.precompile( 'rejected-live-recapture', context );
		await waitFor( () => rejectedBodyRead, 'rejected capture response' );

		assert.equal( posts.length, 2 );
		assert.notEqual( posts[ 1 ].hash, acceptedHash );
		assert.equal( getArtifact( 'rejected-live-recapture' ).__hash, acceptedHash );

	} );

} );

function install( three, extractor, options = {} ) {

	installPrecompileMarker( three, {
		devEndpoint: '/__tsl-precompile/capture',
		extractor,
		codegen: () => ( { unsupportedKinds: [] } ),
		...options,
	} );

}

test( 'aggregates dynamic cube faces and the following main output in one synchronous real-render harvest', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'real-burst' );
		const material = new three.Material();
		const context = mount( three, material );
		const cubeTexture = { isCubeTexture: true, format: 1023 };
		const cubeTarget = { isCubeRenderTarget: true, texture: cubeTexture, textures: [ cubeTexture ] };
		const outputTexture = { isRenderTargetTexture: true, format: 1023, colorSpace: 'srgb-linear' };
		const outputTarget = {
			isPostProcessingRenderTarget: true,
			texture: outputTexture,
			textures: [ outputTexture ],
			samples: 4,
		};
		const renderContext = {
			renderTarget: cubeTarget,
			textures: [ cubeTexture ],
			activeCubeFace: 0,
			activeMipmapLevel: 0,
			sampleCount: 1,
		};
		const nodeBuilderState = { vertexShader: 'real-vertex', fragmentShader: 'real-fragment' };
		const renderObject = {
			cacheKey: 'real-cube-family',
			material,
			object: context.object,
			scene: context.scene,
			camera: context.camera,
			context: renderContext,
			_nodeBuilderState: nodeBuilderState,
		};
		const manager = {
			nodeBuilderCache: new Map( [ [ renderObject.cacheKey, nodeBuilderState ] ] ),
			getForRenderCacheKey: ( object ) => object.cacheKey,
			getForRender: ( object ) => object._nodeBuilderState,
		};
		let extractorCalls = 0;
		let receivedHarvest = null;
		const renderer = {
			_nodes: manager,
			_objects: { get: () => renderObject },
			getRenderTarget: () => renderContext.renderTarget,
			getActiveCubeFace: () => renderContext.activeCubeFace,
			getActiveMipmapLevel: () => renderContext.activeMipmapLevel,
			getMRT: () => null,
			render( scene, camera, activeCubeFace, renderTarget = cubeTarget ) {

				renderContext.renderTarget = renderTarget;
				renderContext.textures = renderTarget.textures;
				renderContext.activeCubeFace = activeCubeFace;
				renderContext.sampleCount = renderTarget.samples || 1;
				renderObject.scene = scene;
				renderObject.camera = camera;
				this._objects.get( renderObject );

			},
		};
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorCalls ++;
			receivedHarvest = options && options.renderObjectHarvest;
			return artifactSet( material );

		}, { beginRenderObjectHarvest } );
		await setDevRenderer( renderer, three );
		material.precompile( 'real-render-burst' );

		for ( let face = 0; face < 6; face ++ ) renderer.render( context.scene, context.camera, face, cubeTarget );
		renderer.render( context.scene, context.camera, 0, outputTarget );
		assert.equal( extractorCalls, 0, 'capture starts after the whole synchronous burst, not after face zero' );
		await waitFor( () => posts.length === 1, 'real-render-burst capture' );

		const family = receivedHarvest && receivedHarvest.familiesByMaterial.get( material );
		assert.ok( family, 'the exact marked material family reaches the extractor' );
		assert.equal( family.complete, true );
		assert.equal( family.variants.length, 1 );
		assert.equal( family.variants[ 0 ].requestCount, 7 );
		const selectors = family.variants[ 0 ].renderContextSelectors.map( ( selector ) => JSON.parse( selector ) );
		const cubeSelectors = selectors.filter( ( selector ) => selector.target.surface === 'offscreen-cube' );
		const outputSelectors = selectors.filter( ( selector ) => selector.target.surface === 'output-intermediate' );
		const faces = cubeSelectors
			.map( ( selector ) => selector.target.activeCubeFace )
			.sort( ( a, b ) => a - b );
		assert.deepEqual( faces, [ 0, 1, 2, 3, 4, 5 ], 'request-time snapshots survive mutable RenderContext reuse' );
		assert.equal( outputSelectors.length, 1, 'the same complete state retains its following main-output selector' );
		assert.equal( outputSelectors[ 0 ].target.sampleCount, 4 );

	} );

} );

test( 'auto-mark context waits for a real render when output target topology is implicit', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'auto-real-render' );
		const material = new three.Material();
		const context = mount( three, material );
		const harvest = { supported: true, familiesByMaterial: new Map( [ [ material, { complete: true, variants: [] } ] ] ) };
		const renderer = { render() {}, getRenderTarget: () => null, getMRT: () => null };
		let extractorCalls = 0;
		let suppliedHarvest = null;
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorCalls ++;
			suppliedHarvest = options && options.renderObjectHarvest || null;
			return artifactSet( material );

		}, { beginRenderObjectHarvest: () => ( { finish: () => harvest } ) } );
		await setDevRenderer( renderer, three );
		material.precompile( 'auto-real-render', { ...context, __tslpAutoMark: true } );
		assert.equal( extractorCalls, 0, 'implicit output topology must not start a synthetic capture immediately' );

		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'auto-mark real-render capture' );
		assert.equal( extractorCalls, 1 );
		assert.equal( suppliedHarvest, harvest );

	} );

} );

test( 'observed-pipeline auto-mark waits for a real render despite explicit MRT context', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'observed-explicit-mrt' );
		const material = new three.Material();
		const context = mount( three, material );
		const observedMRT = { outputNodes: { output: {} } };
		const harvest = { supported: true, familiesByMaterial: new Map( [ [ material, { complete: true, variants: [] } ] ] ) };
		const renderer = { render() {}, getRenderTarget: () => null, getMRT: () => observedMRT };
		const extractorOptions = [];
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorOptions.push( options || {} );
			return artifactSet( material );

		}, { beginRenderObjectHarvest: () => ( { finish: () => harvest } ) } );
		await setDevRenderer( renderer, three );
		material.precompile( 'observed-explicit-mrt', {
			...context,
			mrt: observedMRT,
			__tslpAutoMark: true,
			__tslpObserveNextRender: true,
		} );

		assert.equal( extractorOptions.length, 0, 'explicit MRT capture remains pending until the real draw' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'observed explicit-MRT capture' );

		assert.equal( extractorOptions[ 0 ].renderObjectHarvest, harvest );
		assert.equal( extractorOptions[ 0 ].mrtNode, observedMRT );
		assert.equal( extractorOptions[ 0 ].__tslpObserveNextRender, undefined );
		assert.doesNotMatch( JSON.stringify( posts[ 0 ] ), /__tslpObserveNextRender/, 'queue policy is not persisted in capture metadata' );

	} );

} );

test( 'duplicate auto-mark entries retain the observed-pipeline request across renderer association', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'observed-duplicate' );
		const material = new three.Material();
		const context = mount( three, material );
		const observedMRT = { outputNodes: { output: {} } };
		const harvest = { supported: true, familiesByMaterial: new Map( [ [ material, { complete: true, variants: [] } ] ] ) };
		const renderer = { render() {}, getRenderTarget: () => null, getMRT: () => observedMRT };
		let extractorCalls = 0;
		let suppliedHarvest = null;
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorCalls ++;
			if ( options && options.renderObjectHarvest ) suppliedHarvest = options.renderObjectHarvest;
			return artifactSet( material );

		}, { beginRenderObjectHarvest: () => ( { finish: () => harvest } ) } );

		material.precompile( 'observed-duplicate', { ...context, __tslpAutoMark: true } );
		material.precompile( 'observed-duplicate', {
			...context,
			mrt: observedMRT,
			__tslpAutoMark: true,
			__tslpObserveNextRender: true,
		} );
		await setDevRenderer( renderer, three );

		assert.equal( extractorCalls, 0, 'renderer association preserves the merged observe-next-render policy' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'duplicate observed-pipeline capture' );

		assert.equal( suppliedHarvest, harvest );

	} );

} );

test( 'capture metadata snapshots node properties before material setup', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'pre-setup-node-props' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = {
			getRenderTarget: () => null,
			getMRT: () => null,
			render() {

				// Models Line2NodeMaterial.setup(): the builder materializes internal
				// graph roots during the real render, after artifact matching metadata
				// should already represent the author's graph.
				material.vertexNode = { isNode: true };

			},
		};
		install( three, async () => artifactSet( material ) );
		await setDevRenderer( renderer, three );
		material.precompile( 'pre-setup-node-props', { ...context, __tslpAutoMark: true } );
		material.colorNode = { isNode: true };

		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'pre-setup node metadata capture' );

		assert.deepEqual( posts[ 0 ].artifact.sourceMaterial.nodeProps, [ 'colorNode' ] );

	} );

} );

test( 'capture metadata excludes Line2 roots generated by an earlier setup', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'line2-setup-node-props' );
		const material = new three.Material();
		material.type = 'Line2NodeMaterial';
		material.isLine2NodeMaterial = true;
		material.vertexNode = { isNode: true };
		material.colorNode = { isNode: true };
		material.outputNode = { isNode: true };
		material.offsetNode = { isNode: true };
		const context = mount( three, material );
		const renderer = { render() {} };
		install( three, async () => artifactSet( material ) );
		await setDevRenderer( renderer, three );

		material.precompile( 'line2-setup-node-props', context );
		await waitFor( () => posts.length === 1, 'post-setup Line2 node metadata capture' );

		assert.deepEqual( posts[ 0 ].artifact.sourceMaterial.nodeProps, [ 'offsetNode' ] );

	} );

} );

test( 'publishes a single-scene real-render harvest for one auxiliary consumer', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'single-scene-handoff' );
		const material = new three.Material();
		const context = mount( three, material );
		const harvest = { supported: true, familiesByMaterial: new Map() };
		const renderer = { render() {} };
		install( three, async () => artifactSet( material ), {
			beginRenderObjectHarvest: () => ( { finish: () => harvest } ),
		} );
		await setDevRenderer( renderer, three );
		material.precompile( 'single-scene-handoff' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'single-scene handoff capture' );

		const staged = takeRenderObjectHarvest( renderer, context.scene );
		assert.ok( staged, 'the exact renderer and scene expose the completed epoch once' );
		assert.equal( await staged, harvest );
		assert.equal( takeRenderObjectHarvest( renderer, context.scene ), null );

	} );

} );

test( 'does not publish a mixed multi-scene real-render harvest', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'multi-scene-handoff' );
		const material = new three.Material();
		const first = mount( three, material );
		const second = mount( three, material );
		const renderer = { render() {} };
		install( three, async () => artifactSet( material ), {
			beginRenderObjectHarvest: () => ( { finish: () => ( { supported: true, familiesByMaterial: new Map() } ) } ),
		} );
		await setDevRenderer( renderer, three );
		material.precompile( 'multi-scene-handoff' );
		renderer.render( first.scene, first.camera );
		renderer.render( second.scene, second.camera );
		await waitFor( () => posts.length === 1, 'multi-scene handoff capture' );

		assert.equal( takeRenderObjectHarvest( renderer, first.scene ), null );
		assert.equal( takeRenderObjectHarvest( renderer, second.scene ), null );

	} );

} );

test( 'an unsupported real-render observer preserves synthetic marker capture', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'unsupported-harvest' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let suppliedHarvest = 'not-called';
		install( three, async ( _renderer, _scene, _camera, options ) => {

			suppliedHarvest = options && options.renderObjectHarvest || null;
			return artifactSet( material );

		}, { beginRenderObjectHarvest } );
		await setDevRenderer( renderer, three );
		material.precompile( 'unsupported-harvest' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'unsupported observer fallback capture' );

		assert.equal( suppliedHarvest && suppliedHarvest.supported, false );
		assert.equal( suppliedHarvest.familiesByMaterial.size, 0 );

	} );

} );

test( 'associates each Three installation with its own renderer', async () => {

	await withBrowser( async ( posts ) => {

		const threeA = makeThree( 'a' );
		const threeB = makeThree( 'b' );
		const materialA = new threeA.Material();
		const materialB = new threeB.Material();
		const contextA = mount( threeA, materialA );
		const contextB = mount( threeB, materialB );
		const rendererA = { name: 'renderer-a', render() {} };
		const rendererB = { name: 'renderer-b', render() {} };
		const seen = [];
		install( threeA, async ( renderer ) => { seen.push( renderer.name ); return artifactSet( materialA ); } );
		install( threeB, async ( renderer ) => { seen.push( renderer.name ); return artifactSet( materialB ); } );
		setDevRenderer( rendererA, threeA );
		setDevRenderer( rendererB, threeB );

		materialA.precompile( 'material-a', contextA, 'src/a.js:1:0' );
		materialB.precompile( 'material-b', contextB );
		await waitFor( () => posts.length === 2, 'two captures' );
		assert.deepEqual( seen, [ 'renderer-a', 'renderer-b' ] );
		assert.equal( posts.find( ( post ) => post.name === 'material-a' ).sourceIdentity, 'src/a.js:1:0' );

	} );

} );

test( 'a duplicate runtime module reuses the branded marker state', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'duplicate' );
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		install( three, async () => { throw new Error( 'the duplicate install should replace this extractor' ); } );

		const duplicate = await import( `../src/precompile-marker.js?duplicate-runtime=${ Date.now() }` );
		duplicate.installPrecompileMarker( three, {
			devEndpoint: '/__tsl-precompile/capture',
			extractor: async () => artifactSet( material ),
			codegen: () => ( { unsupportedKinds: [] } ),
		} );
		duplicate.setDevRenderer( renderer, three );
		material.precompile( 'duplicate-runtime', context );
		await waitFor( () => posts.length === 1, 'duplicate-runtime capture' );

	} );

} );

test( 'synthetic extractor renders cannot claim another pending material', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const first = new three.Material();
		const second = new three.Material();
		const firstContext = mount( three, first );
		const secondContext = mount( three, second );
		const renderer = { render() {} };
		let calls = 0;
		install( three, async () => {

			calls ++;
			if ( calls === 1 ) {

				second.precompile( 'second' );
				globalThis.__tslpSyntheticRenderActive = 1;
				try { renderer.render( secondContext.scene, secondContext.camera ); } finally { globalThis.__tslpSyntheticRenderActive = 0; }

			}
			return artifactSet( calls === 1 ? first : second );

		} );
		setDevRenderer( renderer, three );
		first.precompile( 'first' );
		renderer.render( firstContext.scene, firstContext.camera );
		await waitFor( () => posts.length === 1, 'first capture' );
		assert.equal( calls, 1 );
		assert.equal( globalThis.__tslpPrecompilePending, 1 );

		renderer.render( secondContext.scene, secondContext.camera );
		await waitFor( () => posts.length === 2, 'second real-render capture' );
		assert.equal( calls, 2 );

	} );

} );

test( 'a post-render sidecar capture reuses that renderer camera', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let capturedCamera = null;
		install( three, async ( _renderer, _scene, camera ) => {

			capturedCamera = camera;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );
		renderer.render( context.scene, context.camera );
		Object.defineProperty( material, '__tslpPrecompileScene', { value: context.scene } );
		Object.defineProperty( material, '__tslpPrecompileObject', { value: context.object } );
		material.precompile( 'post-render-sidecar' );
		await waitFor( () => posts.length === 1, 'sidecar capture' );
		assert.equal( capturedCamera.isPerspectiveCamera, true );

	} );

} );

test( 'explicit capture applies the renderer coordinate system before extraction', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		const context = mount( three, material );
		context.camera.coordinateSystem = 2000;
		three.PerspectiveCamera.prototype.coordinateSystem = 2000;
		const renderer = { coordinateSystem: 2001, render() {} };
		let capturedCoordinateSystem = null;
		install( three, async ( _renderer, _scene, camera ) => {

			capturedCoordinateSystem = camera.coordinateSystem;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );
		material.precompile( 'renderer-coordinate-system', context );
		await waitFor( () => posts.length === 1, 'coordinate-system capture' );
		assert.equal( capturedCoordinateSystem, 2001 );

	} );

} );

test( 'scene override materials bind to a representative rendered object', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const overrideMaterial = new three.Material();
		const objectMaterial = new three.Material();
		const context = mount( three, objectMaterial );
		context.scene.overrideMaterial = overrideMaterial;
		const renderer = { render() {} };
		let sourceObjectType = null;
		install( three, async ( _renderer, scene ) => {

			scene.traverse( ( object ) => {

				if ( object.material === overrideMaterial ) sourceObjectType = object.type;

			} );
			return artifactSet( overrideMaterial );

		} );
		setDevRenderer( renderer, three );
		overrideMaterial.precompile( 'override-material' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'override capture' );
		assert.equal( sourceObjectType, 'Mesh' );

	} );

} );

test( 'scene override passes leave object materials pending for their main pass', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const overrideMaterial = new three.Material();
		const objectMaterial = new three.Material();
		const context = mount( three, objectMaterial );
		context.scene.overrideMaterial = overrideMaterial;
		const renderer = { render() {} };
		install( three, async ( _renderer, scene ) => {

			let capturedMaterial = null;
			scene.traverse( ( object ) => {

				if ( object.material ) capturedMaterial = object.material;

			} );
			return artifactSet( capturedMaterial );

		} );
		setDevRenderer( renderer, three );
		overrideMaterial.precompile( 'override-material' );
		objectMaterial.precompile( 'object-material' );

		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'override-only capture' );
		assert.equal( posts[ 0 ].name, 'override-material' );
		assert.equal( globalThis.__tslpPrecompilePending, 1 );

		context.scene.overrideMaterial = null;
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 2, 'main-pass object capture' );
		assert.deepEqual( posts.map( ( post ) => post.name ), [ 'override-material', 'object-material' ] );
		assert.equal( globalThis.__tslpPrecompilePending, 0 );

	} );

} );

test( 'only auto-marked unobserved helpers receive a delayed generic fallback', async () => {

	await withBrowser( async ( posts ) => {

		globalThis.__TSLP_AUTO_FALLBACK_DELAY_MS__ = 0;
		const three = makeThree();
		const helper = new three.Material();
		const visible = new three.Material();
		const visibleContext = mount( three, visible );
		const renderer = { render() {} };
		let helperObject = null;
		install( three, async ( _renderer, scene ) => {

			scene.traverse( ( object ) => {

				if ( object.material === helper ) helperObject = object;

			} );
			return artifactSet( helper );

		} );
		setDevRenderer( renderer, three );
		helper.precompile( 'auto-helper', { __tslpAutoMark: true } );
		renderer.render( visibleContext.scene, visibleContext.camera );
		await waitFor( () => posts.length === 1, 'auto fallback capture' );
		assert.equal( helperObject.type, 'Mesh' );

	} );

} );

test( 'auto-mark capture preserves an active non-MRT pass render target', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'pass-target' );
		const material = new three.Material();
		const context = mount( three, material );
		const clonedTarget = {
			width: 640,
			height: 360,
			depthTexture: { image: { width: 640, height: 360 } },
			disposed: false,
			setSize( width, height ) {

				this.width = width;
				this.height = height;

			},
			dispose() { this.disposed = true; },
		};
		const passTarget = {
			cloneCalls: 0,
			clone() {

				this.cloneCalls ++;
				return clonedTarget;

			},
		};
		const renderer = {
			render() {},
			getMRT: () => null,
			// Delayed auto-mark flush runs after PassNode restored the canvas.
			getRenderTarget: () => null,
		};
		let extractorOptions = null;
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorOptions = options;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );

		material.precompile( 'pass-target-material', { ...context, renderTarget: passTarget, __tslpAutoMark: true } );
		await waitFor( () => posts.length === 1, 'non-MRT pass-target capture' );

		assert.equal( extractorOptions.renderTargetOverride, clonedTarget );
		assert.equal( extractorOptions.mrtNode, undefined );
		assert.equal( passTarget.cloneCalls, 1 );
		assert.deepEqual( [ clonedTarget.width, clonedTarget.height ], [ 1, 1 ] );
		assert.deepEqual( clonedTarget.depthTexture.image, { width: 1, height: 1 } );
		assert.equal( clonedTarget.disposed, true );

	} );

} );

test( 'late auto-mark fallback preserves the latest renderer output-intermediate target', async () => {

	await withBrowser( async ( posts ) => {

		globalThis.__TSLP_AUTO_FALLBACK_DELAY_MS__ = 0;
		const three = makeThree( 'output-intermediate' );
		const material = new three.Material();
		const context = mount( three, material );
		const captureTarget = { setSize() {}, dispose() {} };
		const outputIntermediate = {
			isPostProcessingRenderTarget: true,
			clone: () => captureTarget,
		};
		const renderer = {
			render() {},
			getRenderTarget: () => null,
			getMRT: () => null,
			_getFrameBufferTarget: () => outputIntermediate,
		};
		let extractorOptions = null;
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorOptions = options;
			return artifactSet( material );

		} );
		await setDevRenderer( renderer, three );
		renderer.render( context.scene, context.camera );
		material.precompile( 'late-output-intermediate', { ...context, __tslpAutoMark: true } );
		await waitFor( () => posts.length === 1, 'late output-intermediate capture' );

		assert.equal( extractorOptions.renderTargetOverride, captureTarget );
		assert.equal( captureTarget.isPostProcessingRenderTarget, true );

	} );

} );

test( 'explicit marker context preserves observed MRT topology after renderer state changes', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'mrt-context' );
		const material = new three.Material();
		const context = mount( three, material );
		const observedMRT = { outputNodes: { output: {} } };
		const laterMRT = { outputNodes: { normal: {} } };
		material.mrtNode = observedMRT;
		context.scene.userData.__tslp_mrtNode = laterMRT;
		const renderer = {
			render() {},
			getMRT: () => laterMRT,
			getRenderTarget: () => null,
		};
		let extractorOptions = null;
		install( three, async ( _renderer, _scene, _camera, options ) => {

			extractorOptions = options;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );

		material.precompile( 'mrt-context-material', { ...context, mrt: observedMRT, __tslpAutoMark: true } );
		await waitFor( () => posts.length === 1, 'item-scoped MRT capture' );

		assert.equal( extractorOptions.mrtNode, observedMRT );
		assert.notEqual( extractorOptions.mrtNode, laterMRT );

	} );

} );

test( 'coalesces a trailing HMR recapture while extraction is inflight', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		let releaseFirst;
		const firstBlocked = new Promise( ( resolve ) => { releaseFirst = resolve; } );
		let calls = 0;
		install( three, async () => {

			calls ++;
			if ( calls === 1 ) await firstBlocked;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );
		material.precompile( 'hmr-material' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => calls === 1, 'blocked capture' );

		material.precompile( 'hmr-material', context );
		releaseFirst();
		await waitFor( () => posts.length === 2, 'trailing recapture' );
		assert.equal( calls, 2 );

	} );

} );

test( 'a perspective render does not inherit an earlier ArrayCamera', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const first = new three.Material();
		const second = new three.Material();
		const firstContext = mount( three, first );
		const secondContext = mount( three, second );
		const renderer = { render() {} };
		const cameraKinds = [];
		let calls = 0;
		install( three, async ( _renderer, _scene, camera ) => {

			cameraKinds.push( camera.isArrayCamera === true ? 'array' : 'perspective' );
			return artifactSet( calls ++ === 0 ? first : second );

		} );
		setDevRenderer( renderer, three );

		first.precompile( 'array-material' );
		renderer.render( firstContext.scene, new three.ArrayCamera() );
		await waitFor( () => posts.length === 1, 'array capture' );
		second.precompile( 'perspective-material' );
		renderer.render( secondContext.scene, secondContext.camera );
		await waitFor( () => posts.length === 2, 'perspective capture' );
		assert.deepEqual( cameraKinds, [ 'array', 'perspective' ] );

	} );

} );

test( 'renderer replacement disables the old render wrapper', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		const context = mount( three, material );
		const oldRenderer = { render() {} };
		const newRenderer = { render() {} };
		let calls = 0;
		install( three, async () => { calls ++; return artifactSet( material ); } );
		setDevRenderer( oldRenderer, three );
		setDevRenderer( newRenderer, three );

		material.precompile( 'swapped-renderer' );
		oldRenderer.render( context.scene, context.camera );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( calls, 0 );
		newRenderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'new renderer capture' );

	} );

} );

test( 'an explicit capture renderer survives installation renderer replacement', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree( 'explicit-renderer' );
		const material = new three.Material();
		const context = mount( three, material );
		const firstRenderer = { render() {} };
		const replacementRenderer = { render() {} };
		const capturedRenderers = [];
		install( three, async ( renderer ) => {

			capturedRenderers.push( renderer );
			return artifactSet( material );

		} );
		await setDevRenderer( firstRenderer, three );
		await setDevRenderer( replacementRenderer, three );

		material.precompile( 'explicit-first-renderer', { ...context, renderer: firstRenderer } );
		await waitFor( () => posts.length === 1, 'explicit renderer capture' );

		assert.deepEqual( capturedRenderers, [ firstRenderer ] );

	} );

} );

test( 'worker-only environments can capture marked materials', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		install( three, async () => artifactSet( material ) );
		setDevRenderer( renderer, three );
		material.precompile( 'worker-material', context );
		await waitFor( () => posts.length === 1, 'worker capture' );

	}, { worker: true } );

} );

test( 'preserves the source object subclass while forcing synthetic visibility', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		class SkinnedInstancedMesh extends three.Mesh {

			constructor( geometry, material ) {

				super( geometry, material );
				this.type = 'SkinnedInstancedMesh';
				this.isSkinnedMesh = true;
				this.isInstancedMesh = true;

			}

			clone() {

				const cloned = new SkinnedInstancedMesh( this.geometry, this.material );
				cloned.visible = this.visible;
				return cloned;

			}

		}
		const material = new three.Material();
		const context = mount( three, material, SkinnedInstancedMesh );
		context.object.visible = false;
		const renderer = { render() {} };
		let capturedObject = null;
		install( three, async ( _renderer, scene ) => {

			scene.traverse( ( object ) => {

				if ( object.material === material ) capturedObject = object;

			} );
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );
		material.precompile( 'subclass-material' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'subclass capture' );
		assert.ok( capturedObject instanceof SkinnedInstancedMesh );
		assert.equal( capturedObject.isSkinnedMesh, true );
		assert.equal( capturedObject.isInstancedMesh, true );
		assert.equal( capturedObject.visible, true );

	} );

} );

test( 'capture cleanup does not overwrite a render function replaced mid-capture', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		const context = mount( three, material );
		const renderer = { render() {} };
		const replacement = () => 'replacement';
		install( three, async () => {

			renderer.render = replacement;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );
		material.precompile( 'render-replacement' );
		renderer.render( context.scene, context.camera );
		await waitFor( () => posts.length === 1, 'capture' );
		assert.equal( renderer.render, replacement );

	} );

} );

test( 'captures thin double-sided transmission without collapsing its pass topology', async () => {

	await withBrowser( async ( posts ) => {

		const three = makeThree();
		const material = new three.Material();
		material.transmission = 1;
		material.thickness = 0;
		material.side = 2;
		material.forceSinglePass = false;
		const context = mount( three, material );
		const renderer = { render() {} };
		let capturedForceSinglePass = null;
		install( three, async () => {

			capturedForceSinglePass = material.forceSinglePass;
			return artifactSet( material );

		} );
		setDevRenderer( renderer, three );
		material.precompile( 'thin-transmission', context );
		await waitFor( () => posts.length === 1, 'thin transmission capture' );
		assert.equal( capturedForceSinglePass, false );
		assert.equal( material.forceSinglePass, false );

	} );

} );
