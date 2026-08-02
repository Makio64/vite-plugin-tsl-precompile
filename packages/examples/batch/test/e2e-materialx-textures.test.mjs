import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = [
	readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' ),
	readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' ),
].join( '\n' );

function extractFunction( name, nextName, ...parameters ) {

	const start = source.indexOf( `function ${ name }(` );
	const end = source.indexOf( `\n\nfunction ${ nextName }(`, start );
	assert.ok( start >= 0 && end > start, `expected ${ name } helper` );
	return Function(
		...parameters.map( ( [ parameter ] ) => parameter ),
		`"use strict";\n${ source.slice( start, end ) }\nreturn ${ name };`,
	)( ...parameters.map( ( [ , value ] ) => value ) );

}

function materialXRewriter() {

	return extractFunction(
		'rewriteMaterialXLoaderTextureIdentity',
		'rewriteReplayAddon',
	);

}

function rewrittenMaterialXProbe( baseURI, loaderPath, uri ) {

	const rewrite = materialXRewriter();
	const fixture = `class MaterialXLoader {}
class Probe {
\tgetTexture( uri ) {
\t\tconst texture = new Texture();
\t\ttexture.wrapS = texture.wrapT = RepeatWrapping;
\t\t\ttexture.image = imageBitmap;
\t\t\ttexture.needsUpdate = true;
\t\t\treturn texture;
\t}
}`;
	const rewritten = rewrite( fixture );
	assert.match( rewritten, /__tslpLoaderUrl = __tslpMaterialXTextureUrl/, 'expected the loader identity rewrite to apply' );
	const previousDocument = globalThis.document;
	const previousMarker = globalThis.__tslpMarkLoaderTexture;
	let markedUrl = null;
	try {

		globalThis.document = { baseURI };
		globalThis.__tslpMarkLoaderTexture = ( _texture, url ) => { markedUrl = url; };
		class Texture {

			constructor() {

				this.name = '';
				this.userData = {};

			}

		}
		const Probe = Function(
			'Texture',
			'RepeatWrapping',
			'imageBitmap',
			`${ rewritten }\nreturn Probe;`,
		)( Texture, 'repeat', {}, );
		const probe = new Probe();
		probe.materialX = { path: loaderPath };
		const texture = probe.getTexture( uri );
		return { texture, markedUrl, rewritten };

	} finally {

		if ( previousDocument === undefined ) delete globalThis.document;
		else globalThis.document = previousDocument;
		if ( previousMarker === undefined ) delete globalThis.__tslpMarkLoaderTexture;
		else globalThis.__tslpMarkLoaderTexture = previousMarker;

	}

}

test( 'MaterialX rewrite records absolute remote and local loader texture identities', () => {

	const remote = rewrittenMaterialXProbe(
		'http://127.0.0.1:8729/examples/webgpu_loader_materialx.html',
		'https://raw.githubusercontent.com/materialx/MaterialX/main/resources/Materials/Examples/StandardSurface/',
		'../../../Images/brass_color.jpg',
	);
	const remoteUrl = 'https://raw.githubusercontent.com/materialx/MaterialX/main/resources/Images/brass_color.jpg';
	assert.equal( remote.texture.userData.__tslpLoaderUrl, remoteUrl );
	assert.equal( remote.markedUrl, remoteUrl );
	assert.equal( remote.texture.name, 'brass_color.jpg' );

	const local = rewrittenMaterialXProbe(
		'http://127.0.0.1:8729/examples/webgpu_loader_materialx.html',
		'materialx/',
		'resources/Images/grid.png',
	);
	const localUrl = 'http://127.0.0.1:8729/examples/materialx/resources/Images/grid.png';
	assert.equal( local.texture.userData.__tslpLoaderUrl, localUrl );
	assert.equal( local.markedUrl, localUrl );
	assert.doesNotMatch( local.rewritten, /__tslpMarkLoaderTexture\( texture, uri \)/ );

} );

test( 'artifact texture fallback strips only the current origin', () => {

	const fallbackUrl = extractFunction(
		'__artifactTextureFallbackUrl',
		'__makeFallbackArtifactTexture',
		[ 'window', {
			location: {
				href: 'http://127.0.0.1:8729/examples/webgpu_loader_materialx.html',
				origin: 'http://127.0.0.1:8729',
			},
		} ],
	);
	assert.equal(
		fallbackUrl( 'http://127.0.0.1:8729/examples/materialx/resources/Images/grid.png' ),
		'/examples/materialx/resources/Images/grid.png',
	);
	assert.equal(
		fallbackUrl( 'https://raw.githubusercontent.com/materialx/MaterialX/main/resources/Images/brass_color.jpg' ),
		'https://raw.githubusercontent.com/materialx/MaterialX/main/resources/Images/brass_color.jpg',
	);

} );
