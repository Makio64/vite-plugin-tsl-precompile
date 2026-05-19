import { Vector3 } from 'three';

const _lightPos = new Vector3();

export function updateDynamicLightUniforms( artifact, group, renderView, uniformBuffers, frame ) {

	const plan = getDynamicLightPlan( artifact, group );
	if ( ! plan ) return false;
	const scene = frame && frame.scene;
	const camera = frame && frame.camera;
	if ( ! scene || ! camera || ! camera.matrixWorldInverse ) return false;

	const pointLights = collectPointLights( scene );
	const count = Math.min( pointLights.length, plan.maxPointLights );

	if ( plan.ambientSlot ) writeAmbientColor( renderView, plan.ambientSlot, scene );
	if ( plan.countSlot ) renderView.setInt32( plan.countSlot.offset ?? plan.countSlot.byteOffset ?? 0, count, true );

	const positionBinding = uniformBuffers.get( plan.positionBinding );
	const colorBinding = uniformBuffers.get( plan.colorBinding );
	const decayBinding = uniformBuffers.get( plan.decayBinding );
	const positions = positionBinding && positionBinding.buffer;
	const colors = colorBinding && colorBinding.buffer;
	const decays = decayBinding && decayBinding.buffer;
	if ( ! positions || ! colors || ! decays ) return true;

	for ( let i = 0; i < count; i ++ ) {

		const light = pointLights[ i ];
		const base = i * 4;
		const intensity = Number.isFinite( light.intensity ) ? light.intensity : 1;
		const color = light.color || null;

		colors[ base + 0 ] = color ? color.r * intensity : 0;
		colors[ base + 1 ] = color ? color.g * intensity : 0;
		colors[ base + 2 ] = color ? color.b * intensity : 0;
		colors[ base + 3 ] = 0;

		if ( light.matrixWorld ) _lightPos.setFromMatrixPosition( light.matrixWorld );
		else if ( light.position ) _lightPos.copy( light.position );
		else _lightPos.set( 0, 0, 0 );
		_lightPos.applyMatrix4( camera.matrixWorldInverse );
		positions[ base + 0 ] = _lightPos.x;
		positions[ base + 1 ] = _lightPos.y;
		positions[ base + 2 ] = _lightPos.z;
		positions[ base + 3 ] = Number.isFinite( light.distance ) ? light.distance : 0;

		decays[ base + 0 ] = Number.isFinite( light.decay ) ? light.decay : 2;
		decays[ base + 1 ] = 0;
		decays[ base + 2 ] = 0;
		decays[ base + 3 ] = 1;

	}

	return true;

}

function getDynamicLightPlan( artifact, group ) {

	if ( ! artifact || ! group ) return null;
	const cacheKey = `__tslpDynamicLightPlan_${ group.name || '' }`;
	if ( Object.prototype.hasOwnProperty.call( artifact, cacheKey ) ) return artifact[ cacheKey ];

	const bindingGroup = findBindingGroup( artifact, group.name );
	if ( ! bindingGroup || ! Array.isArray( bindingGroup.bindings ) ) return cachePlan( artifact, cacheKey, null );

	const shader = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }`;
	const groupIndex = findBindingGroupIndex( artifact, group.name );
	if ( groupIndex < 0 ) return cachePlan( artifact, cacheKey, null );

	const varsByBinding = parseUniformBufferVars( shader, groupIndex );
	if ( varsByBinding.size === 0 ) return cachePlan( artifact, cacheKey, null );

	const positionVar = findVarByUse( varsByBinding, shader, ( name ) => (
		new RegExp( `${ escapeRegExp( name ) }\\.value\\s*\\[\\s*i\\s*\\]\\.xyz\\s*-\\s*v_positionView` ).test( shader ) &&
		new RegExp( `${ escapeRegExp( name ) }\\.value\\s*\\[\\s*i\\s*\\]\\.w` ).test( shader )
	) );
	const colorVar = findVarByUse( varsByBinding, shader, ( name ) => (
		new RegExp( `${ escapeRegExp( name ) }\\.value\\s*\\[\\s*i\\s*\\]\\.xyz\\s*\\*` ).test( shader )
	) );
	const decayVar = findVarByUse( varsByBinding, shader, ( name ) => (
		new RegExp( `pow\\s*\\([\\s\\S]*?,\\s*${ escapeRegExp( name ) }\\.value\\s*\\[\\s*i\\s*\\]\\.x` ).test( shader )
	) );
	const countName = findLoopCountField( shader );
	if ( ! positionVar || ! colorVar || ! decayVar || ! countName ) return cachePlan( artifact, cacheKey, null );

	const positionBinding = bindingNameForVar( varsByBinding, bindingGroup, positionVar );
	const colorBinding = bindingNameForVar( varsByBinding, bindingGroup, colorVar );
	const decayBinding = bindingNameForVar( varsByBinding, bindingGroup, decayVar );
	if ( ! positionBinding || ! colorBinding || ! decayBinding ) return cachePlan( artifact, cacheKey, null );

	const positionDescriptor = bindingGroup.bindings.find( ( binding ) => binding && binding.name === positionBinding );
	const maxPointLights = Math.max( 0, Math.floor( ( positionDescriptor && positionDescriptor.byteLength || 0 ) / 16 ) );
	if ( maxPointLights === 0 ) return cachePlan( artifact, cacheKey, null );

	const plan = {
		positionBinding,
		colorBinding,
		decayBinding,
		maxPointLights,
		countSlot: findSlot( group, countName ),
		ambientSlot: findSlot( group, findAmbientField( shader ) ),
	};
	return cachePlan( artifact, cacheKey, plan );

}

function cachePlan( artifact, key, value ) {

	Object.defineProperty( artifact, key, {
		value,
		configurable: true,
		writable: true,
	} );
	return value;

}

function findBindingGroupIndex( artifact, groupName ) {

	const bindings = Array.isArray( artifact.bindings ) ? artifact.bindings : [];
	return bindings.findIndex( ( entry ) => ( entry && entry.name || '' ) === ( groupName || '' ) );

}

function findBindingGroup( artifact, groupName ) {

	const bindings = Array.isArray( artifact.bindings ) ? artifact.bindings : [];
	return bindings.find( ( entry ) => ( entry && entry.name || '' ) === ( groupName || '' ) ) || null;

}

function parseUniformBufferVars( shader, groupIndex ) {

	const out = new Map();
	const re = /@binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\)\s*var<uniform>\s+([A-Za-z_$][\w$]*)\s*:/g;
	let match;
	while ( ( match = re.exec( shader ) ) ) {

		if ( Number( match[ 2 ] ) !== groupIndex ) continue;
		out.set( Number( match[ 1 ] ), match[ 3 ] );

	}
	return out;

}

function findVarByUse( varsByBinding, shader, predicate ) {

	for ( const name of varsByBinding.values() ) {

		if ( predicate( name, shader ) ) return name;

	}
	return null;

}

function bindingNameForVar( varsByBinding, group, varName ) {

	for ( const [ bindingIndex, name ] of varsByBinding ) {

		if ( name !== varName ) continue;
		const descriptor = group.bindings[ bindingIndex ];
		return descriptor && descriptor.name || null;

	}
	return null;

}

function findLoopCountField( shader ) {

	const match = /for\s*\(\s*var\s+\w+\s*:\s*i32\s*=\s*0\s*;\s*\w+\s*<\s*render\.([A-Za-z_$][\w$]*)/.exec( shader );
	return match && match[ 1 ] || null;

}

function findAmbientField( shader ) {

	const match = /irradiance\s*\+\s*render\.([A-Za-z_$][\w$]*)/.exec( shader );
	return match && match[ 1 ] || null;

}

function findSlot( group, name ) {

	if ( ! name || ! Array.isArray( group.slots ) ) return null;
	return group.slots.find( ( slot ) => slot && slot.name === name ) || null;

}

function collectPointLights( scene ) {

	const lights = [];
	if ( scene && typeof scene.traverse === 'function' ) {

		scene.traverse( ( object ) => {

			if ( object && object.isPointLight === true && object.isNode !== true && object.castShadow !== true ) lights.push( object );

		} );

	}
	lights.sort( ( a, b ) => ( a.id || 0 ) - ( b.id || 0 ) );
	return lights;

}

function writeAmbientColor( view, slot, scene ) {

	const offset = slot.offset ?? slot.byteOffset ?? 0;
	let r = 0;
	let g = 0;
	let b = 0;
	if ( scene && typeof scene.traverse === 'function' ) {

		scene.traverse( ( object ) => {

			if ( ! object || object.isAmbientLight !== true ) return;
			const color = object.color || null;
			const intensity = Number.isFinite( object.intensity ) ? object.intensity : 1;
			r += color ? color.r * intensity : 0;
			g += color ? color.g * intensity : 0;
			b += color ? color.b * intensity : 0;

		} );

	}
	view.setFloat32( offset + 0, r, true );
	view.setFloat32( offset + 4, g, true );
	view.setFloat32( offset + 8, b, true );

}

function escapeRegExp( value ) {

	return String( value ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}
