import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveArtifactTextureBinding } from '../src/hydrate/artifact-texture-resolver.js';
import { lookupMaterialNodeTexture } from '../src/hydrate/material-node-textures.js';

function texture( uuid, name = '', renderTarget = false ) {

	return {
		isTexture: true,
		isRenderTargetTexture: renderTarget,
		isDepthTexture: false,
		isCubeTexture: false,
		uuid,
		name,
		image: { width: 512, height: 512 },
	};

}

function materialWithPublicTexture( publicTexture ) {

	return {
		colorNode: {
			isNode: true,
			value: publicTexture,
			getChildren() {

				return [];

			},
		},
	};

}

function artifactFor( source, textureRef = null ) {

	const artifact = {
		fragmentShader: '@group(0) @binding(0) var nodeUniform0: texture_2d<f32>;',
		uniformPlan: [
			{
				name: 'node',
				textures: [
					{
						name: 'nodeUniform0',
						bindingKind: 'sampledTexture',
						source,
					},
				],
			},
		],
	};
	if ( textureRef ) artifact._textureRefs = new Map( [ [ source.textureUuid, textureRef ] ] );
	return artifact;

}

test( 'named private effect output does not fall back to the sole public graph input', () => {

	const input = texture( 'input' );
	const output = texture( 'output', 'GaussianBlurNode.vertical', true );
	const source = {
		kind: 'artifact.texture',
		textureUuid: output.uuid,
		textureName: output.name,
		imageWidth: 512,
		imageHeight: 512,
	};
	const material = materialWithPublicTexture( input );
	const artifact = artifactFor( source );

	assert.equal(
		lookupMaterialNodeTexture( material, source, artifact, 'nodeUniform0' ),
		null,
		'a stable output identity must fall through when public traversal only exposes the effect input',
	);

} );

test( 'named private effect output falls through to its exact render-target ref', () => {

	const input = texture( 'input' );
	const output = texture( 'output', 'GaussianBlurNode.vertical', true );
	const source = {
		kind: 'artifact.texture',
		textureUuid: output.uuid,
		textureName: output.name,
		imageWidth: 512,
		imageHeight: 512,
	};
	const material = materialWithPublicTexture( input );
	const artifact = artifactFor( source, output );

	const result = resolveArtifactTextureBinding( {
		artifact,
		bindingName: 'nodeUniform0',
		groupName: 'node',
		material,
		options: {},
		source,
		textureEntry: artifact.uniformPlan[ 0 ].textures[ 0 ],
		deps: {
			applyTextureSourceSettings: value => value,
			lookupMaterialNodeTexture,
			lookupLiveTextureByIdentity: () => null,
		},
	} );

	assert.equal( result.texture, output );
	assert.equal( result.strategy, 'render-target-texture-ref' );

} );

test( 'identity-poor source retains sole-candidate material graph fallback', () => {

	const input = texture( 'runtime-input' );
	const source = {
		kind: 'artifact.texture',
		textureUuid: 'captured-anonymous-input',
		imageWidth: 512,
		imageHeight: 512,
	};
	const material = materialWithPublicTexture( input );
	const artifact = artifactFor( source );

	assert.equal(
		lookupMaterialNodeTexture( material, source, artifact, 'nodeUniform0' ),
		input,
	);

} );
