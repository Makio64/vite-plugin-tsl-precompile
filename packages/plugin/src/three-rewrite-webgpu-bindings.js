/** Native WebGPU group/cache ownership and replay resource preparation. */
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { parseFunctionBody, findClassMethod } from './three-rewrite-ast.js';
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

export function patchNativeBindGroupSetting( ast ) {

	const draw = findClassMethod( ast, '_draw' );
	const lastParameter = draw?.params.at( - 1 );
	if ( ! t.isAssignmentPattern( lastParameter ) || ! t.isIdentifier( lastParameter.left, { name: 'cameraIndexSlot' } ) ) return false;
	const expected = parseFunctionBody( `
		for ( let i = 0, l = bindings.length; i < l; i ++ ) {
			if ( i === cameraIndexSlot ) continue;
			const bindGroup = bindings[ i ];
			const bindGroupGPU = this.get( bindGroup ).group;
			if ( currentBindingGroups[ i ] !== bindGroupGPU ) {
				passEncoderGPU.setBindGroup( i, bindGroupGPU );
				currentBindingGroups[ i ] = bindGroupGPU;
			}
		}
	` ).body[ 0 ];
	const expectedCamera = parseFunctionBody( `
		if ( indexPos !== - 1 && cameraData.indexesGPU ) {
			const cameraIndexGPU = cameraData.indexesGPU[ i ];
			if ( sets.bindingGroups[ indexPos ] !== cameraIndexGPU ) {
				pass.setBindGroup( indexPos, cameraIndexGPU );
				sets.bindingGroups[ indexPos ] = cameraIndexGPU;
			}
		}
	` ).body[ 0 ];
	const compact = node => generate( node, { compact: true, comments: false } ).code;
	let patched = 0;
	let cameraGuards = 0;
	let cameraDraws = 0;
	const samplerOwner = getWebGPUBackendSamplerBindingOwner( ast );
	traverse( ast, {
		ForStatement( path ) {

			if ( path.getFunctionParent()?.node !== draw ) return;
			if ( ! path.node.body.body.some( statement => t.isVariableDeclaration( statement ) &&
				statement.declarations.some( declaration => t.isIdentifier( declaration.id, { name: 'bindGroupGPU' } ) ) ) ) return;
			if ( compact( path.node ) !== compact( expected ) ) throw new Error( 'WebGPUBackend: native bind group loop shape changed' );
			path.node.body.body.splice( 2, 0,
				...parseFunctionBody( 'const bindingsData = this.get( bindGroup );' ).body,
				createReplayBindGroupInitialization( samplerOwner ),
			);
			patched ++;

		},
		IfStatement( path ) {

			if ( ! compact( path.node.test ).includes( 'cameraData.indexesGPU' ) ||
				! path.node.consequent.body?.some( statement => t.isVariableDeclaration( statement ) &&
					statement.declarations.some( declaration => t.isIdentifier( declaration.id, { name: 'cameraIndexGPU' } ) ) ) ) return;
			if ( compact( path.node ) !== compact( expectedCamera ) ) throw new Error( 'WebGPUBackend: native camera index binding shape changed' );
			cameraGuards ++;

		},
		CallExpression( path ) {

			if ( ! t.isMemberExpression( path.node.callee ) || ! t.isThisExpression( path.node.callee.object ) ||
				! t.isIdentifier( path.node.callee.property, { name: '_draw' } ) ) return;
			if ( path.node.arguments.length === 10 && t.isIdentifier( path.node.arguments.at( - 1 ), { name: 'indexPos' } ) ) cameraDraws ++;

		},
	} );
	if ( patched !== 1 || cameraGuards !== 1 || cameraDraws !== 1 ) throw new Error( 'WebGPUBackend: native camera/bind group ownership shape changed' );
	return true;

}

export function createReplayBindGroupInitialization( samplerBindingOwner ) {

	const samplerInitialization = samplerBindingOwner === 'binding'
		? `const bindingData = this.get( binding );
			if ( bindingData.sampler === undefined ) this.updateSampler( binding );`
		: `const texture = binding.texture;
			const textureData = texture ? this.get( texture ) : null;
			if ( textureData && textureData.sampler === undefined ) this.updateSampler( texture );`;
	return parseFunctionBody( `
		if ( bindingsData.group === undefined ) {
			for ( const binding of bindGroup.bindings ) {
				if ( binding.isUniformBuffer ) {
					const bindingData = this.get( binding );
					if ( bindingData.buffer === undefined ) this.createUniformBuffer( binding );
				} else if ( binding.isSampledTexture ) {
					const texture = binding.texture;
					const textureData = texture ? this.get( texture ) : null;
					if ( textureData && textureData.texture === undefined && textureData.externalTexture === undefined ) {
						if ( this.renderer && this.renderer._textures ) {
							texture.needsUpdate = true;
							this.renderer._textures.updateTexture( texture );
						} else {
							this.createDefaultTexture( texture );
						}
					}
				} else if ( binding.isSampler ) {
					${ samplerInitialization }
				}
			}
			this.createBindings( bindGroup, bindings, 0 );
		}
	` ).body[ 0 ];

}

export function getWebGPUBackendSamplerBindingOwner( ast ) {

	const method = findClassMethod( ast, 'updateSampler' );
	if ( ! method || method.params.length !== 1 || ! t.isIdentifier( method.params[ 0 ] ) ) {

		throw new Error( 'WebGPUBackend: updateSampler signature shape changed' );

	}
	const owner = method.params[ 0 ].name;
	if ( owner !== 'texture' && owner !== 'binding' ) {

		throw new Error( `WebGPUBackend: unsupported updateSampler owner ${ owner }` );

	}
	const statements = method.body.body;
	const returned = statements.length === 1 && t.isReturnStatement( statements[ 0 ] )
		? statements[ 0 ].argument
		: null;
	if ( ! t.isCallExpression( returned )
		|| ! t.isMemberExpression( returned.callee )
		|| ! t.isMemberExpression( returned.callee.object )
		|| ! t.isThisExpression( returned.callee.object.object )
		|| ! t.isIdentifier( returned.callee.object.property, { name: 'textureUtils' } )
		|| ! t.isIdentifier( returned.callee.property, { name: 'updateSampler' } )
		|| returned.arguments.length !== 1
		|| ! t.isIdentifier( returned.arguments[ 0 ], { name: owner } ) ) {

		throw new Error( 'WebGPUBackend: updateSampler delegation shape changed' );

	}
	return owner;

}
