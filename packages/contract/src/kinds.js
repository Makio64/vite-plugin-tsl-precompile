import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';

export const KIND_STATUS = Object.freeze( {
	CODEGEN: 'codegen',
	RUNTIME_TEXTURE: 'runtime-texture',
	RUNTIME_DYNAMIC: 'runtime-dynamic',
	BLOCKED: 'blocked',
	ALIAS: 'alias',
} );

export const BLOCKED_KINDS = Object.freeze( {
	'builtin.dfgLUT': 'IBL DFG LUT — resolved by the hydrator (getDFGLUT()). Not a UBO slot kind.',
	'builtin.ltcTexture': 'Area-light LTC texture — resolved by the hydrator from artifact.ltcTextures. Not a UBO slot kind.',
	'artifact.texture': 'Artifact-level texture — resolved by the hydrator via _textureRefs / material UUID scan. Not a UBO slot kind.',
	'depth.texture': 'Shadow depth texture (light.shadow.map.depthTexture) — resolved by the hydrator per-frame via the lightIndex baked into the source. Not a UBO slot kind.',
	'viewport.texture': 'Viewport-mip framebuffer texture (KHR_materials_transmission glass) — resolved by the hydrator via createViewportTextureRebinder, which drives a real ViewportTextureNode per render. Not a UBO slot kind.',
	'reflector.texture': 'Reflector render-target texture — resolved by the hydrator via createReflectorTextureRebinder, which binds the live ReflectorBaseNode render target per render. Not a UBO slot kind.',
	'unsupported': 'Extractor flagged this texture binding as unsupported (no source identified). The hydrator substitutes a 1×1 white fallback. Not a UBO slot kind.',
	'scene.overrideMaterial': 'scene.overrideMaterial context is out of scope for v1.',
} );

const CODEGEN_SLOT_KINDS = [
	'camera.projectionMatrix',
	'camera.projectionMatrixInverse',
	'camera.viewMatrix',
	'camera.worldMatrix',
	'camera.position',
	'camera.near',
	'camera.far',
	'object.worldMatrix',
	'object.worldMatrixInverse',
	'object.normalMatrix',
	'object.modelViewMatrix',
	'object.scale',
	'object3d.worldMatrix',
	'object3d.normalMatrix',
	'object3d.modelViewMatrix',
	'object3d.position',
	'object3d.scale',
	'object3d.viewPosition',
	'object3d.direction',
	'object3d.radius',
	'object3d.userData',
	'frame.time',
	'frame.deltaTime',
	'frame.frameId',
	'renderer.dpr',
	'renderer.size',
	'renderer.halfHeight',
	'renderer.viewport',
	'renderer.toneMappingExposure',
	'scene.fog.color',
	'scene.fog.near',
	'scene.fog.far',
	'scene.fog.density',
	'scene.environmentIntensity',
	'scene.backgroundIntensity',
	'scene.backgroundBlurriness',
	'scene.backgroundRotation',
	'light.colorScaled',
	'light.distance',
	'light.decay',
	'light.coneCos',
	'light.penumbraCos',
	'light.position',
	'light.viewPosition',
	'light.targetPosition',
	'light.halfWidth',
	'light.halfHeight',
	'light.shadowMatrix',
	'light.shadowBias',
	'light.shadowNormalBias',
	'light.shadowRadius',
	'light.shadowIntensity',
	'light.shadowBlurSamples',
	'light.shadowCameraNear',
	'light.shadowCameraFar',
	'light.shadowMapSize',
	'constant',
	'uniform.constant',
	'uniform.live',
];

const LEGACY_ALIASES = Object.freeze( {
	time: 'frame.time',
	deltaTime: 'frame.deltaTime',
	frameId: 'frame.frameId',
} );

const MATERIAL_COLOR_KINDS = [
	'material.color',
	'material.emissive',
	'material.specular',
	'material.specularColor',
	'material.sheenColor',
	'material.attenuationColor',
];

const MATERIAL_SCALAR_KINDS = [
	'material.scalar',
	'material.opacity',
	'material.alphaTest',
	'material.roughness',
	'material.metalness',
	'material.ior',
	'material.emissiveIntensity',
	'material.aoMapIntensity',
	'material.lightMapIntensity',
	'material.envMapIntensity',
	'material.specularIntensity',
	'material.shininess',
	'material.size',
	'material.rotation',
	'material.clearcoat',
	'material.clearcoatRoughness',
	'material.sheen',
	'material.sheenRoughness',
	'material.transmission',
	'material.thickness',
	'material.attenuationDistance',
	'material.iridescence',
	'material.iridescenceIOR',
	'material.anisotropy',
	'material.anisotropyRotation',
	'material.dispersion',
	'material.reflectivity',
	'material.refractionRatio',
	'material.bumpScale',
	'material.displacementScale',
	'material.displacementBias',
	'material.linewidth',
	'material.scale',
	'material.dashSize',
	'material.gapSize',
	'material.dashOffset',
];

const MATERIAL_VECTOR_KINDS = [
	'material.normalScale',
	'material.clearcoatNormalScale',
];

function defineKinds( out, kinds, status, meta = {} ) {

	for ( const kind of kinds ) {

		out[ kind ] = Object.freeze( { kind, status, ...meta } );

	}

}

const kinds = {};
defineKinds( kinds, CODEGEN_SLOT_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater' } );
defineKinds( kinds, MATERIAL_COLOR_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater', value: 'color' } );
defineKinds( kinds, MATERIAL_SCALAR_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater', value: 'f32' } );
defineKinds( kinds, MATERIAL_VECTOR_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater', value: 'vec2' } );
for ( const [ kind, target ] of Object.entries( LEGACY_ALIASES ) ) {

	kinds[ kind ] = Object.freeze( { kind, status: KIND_STATUS.ALIAS, target, codegen: 'emit-updater' } );

}
for ( const [ kind, reason ] of Object.entries( BLOCKED_KINDS ) ) {

	kinds[ kind ] = Object.freeze( { kind, status: KIND_STATUS.BLOCKED, reason } );

}
for ( const prop of MATERIAL_TEXTURE_PROPS ) {

	const kind = `material.${ prop }`;
	kinds[ kind ] = Object.freeze( { kind, status: KIND_STATUS.RUNTIME_TEXTURE, runtime: 'hydrator/material-texture', property: prop } );
	const matrixKind = `${ kind }.matrix`;
	kinds[ matrixKind ] = Object.freeze( { kind: matrixKind, status: KIND_STATUS.CODEGEN, codegen: 'emit-updater', property: prop, value: 'mat3' } );

}

export const KINDS = Object.freeze( kinds );

export const CODEGEN_KINDS = Object.freeze(
	Object.keys( KINDS ).filter( ( kind ) => KINDS[ kind ].status === KIND_STATUS.CODEGEN || KINDS[ kind ].status === KIND_STATUS.ALIAS )
);

export const RUNTIME_TEXTURE_KINDS = Object.freeze(
	Object.keys( KINDS ).filter( ( kind ) => KINDS[ kind ].status === KIND_STATUS.RUNTIME_TEXTURE )
);

function dynamicKindInfo( kind ) {

	if ( typeof kind !== 'string' || kind.length === 0 ) return null;
	if ( Object.prototype.hasOwnProperty.call( KINDS, kind ) ) return KINDS[ kind ];

	if ( kind.startsWith( 'object3d.' ) ) {

		return Object.freeze( {
			kind,
			status: KIND_STATUS.BLOCKED,
			reason: `Object3DNode scope "${ kind.slice( 'object3d.'.length ) }" is not mapped yet.`,
			dynamic: true,
		} );

	}

	return null;

}

export function kindInfo( kind ) {

	return dynamicKindInfo( kind );

}

export function isKnownKind( kind ) {

	return kindInfo( kind ) !== null;

}

export function isBlockedKind( kind ) {

	const info = kindInfo( kind );
	return info ? info.status === KIND_STATUS.BLOCKED : false;

}

export function blockedKindReason( kind ) {

	const info = kindInfo( kind );
	return info && info.status === KIND_STATUS.BLOCKED ? info.reason : null;

}

export function collectArtifactSourceKinds( input ) {

	const artifact = input && input.artifact && typeof input.artifact === 'object' ? input.artifact : input;
	const out = new Set();
	const plan = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	for ( const group of plan ) {

		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			const kind = slot && slot.source && slot.source.kind;
			if ( typeof kind === 'string' && kind.length > 0 ) out.add( kind );

		}
		for ( const texture of group && Array.isArray( group.textures ) ? group.textures : [] ) {

			const kind = texture && texture.source && texture.source.kind;
			if ( typeof kind === 'string' && kind.length > 0 ) out.add( kind );

		}

	}
	return Object.freeze( [ ...out ].sort() );

}

function validationError( code, message, path = '' ) {

	return { code, message, path };

}

export function isArtifactModule( value ) {

	return !! ( value && typeof value === 'object' && ! Array.isArray( value ) && value.artifact && typeof value.artifact === 'object' );

}

export function isArtifactCollection( input, opts = {} ) {

	if ( Array.isArray( input ) ) return input.length > 0 ? input.every( isArtifactModule ) : opts.allowEmpty === true;
	if ( ! input || typeof input !== 'object' || Array.isArray( input ) || input.artifact ) return false;
	const values = Object.values( input );
	return values.length > 0 ? values.every( isArtifactModule ) : opts.allowEmpty === true;

}

function validateArtifactCollection( input, opts, label ) {

	const errors = [];
	const warnings = [];
	const sourceKinds = new Set();
	const entries = Array.isArray( input ) ? input.map( ( value, index ) => [ index, value ] ) : Object.entries( input );
	for ( const [ key, value ] of entries ) {

		const entryLabel = `${ label }[${ JSON.stringify( key ) }]`;
		const result = validateArtifact( value, { ...opts, label: entryLabel } );
		for ( const error of result.errors ) errors.push( error );
		for ( const warning of result.warnings ) warnings.push( warning );
		for ( const kind of result.sourceKinds ) sourceKinds.add( kind );

	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		sourceKinds: Object.freeze( [ ...sourceKinds ].sort() ),
	};

}

export function validateArtifact( input, opts = {} ) {

	const label = opts.label || input && ( input.__name || input.name ) || '<artifact>';
	const errors = [];
	const warnings = [];

	if ( isArtifactCollection( input, { allowEmpty: opts.allowEmptyCollection === true } ) ) return validateArtifactCollection( input, opts, label );

	const artifact = input && input.artifact && typeof input.artifact === 'object' ? input.artifact : input;

	if ( ! artifact || typeof artifact !== 'object' || Array.isArray( artifact ) ) {

		errors.push( validationError( 'artifact.type', `${ label }: artifact must be an object` ) );
		return { ok: false, errors, warnings, sourceKinds: [] };

	}

	if ( ! Array.isArray( artifact.uniformPlan ) ) {

		errors.push( validationError( 'artifact.uniformPlan', `${ label}: artifact.uniformPlan must be an array`, 'uniformPlan' ) );

	}

	const isCompute = artifact.kind === 'compute' || typeof artifact.computeShader === 'string';
	if ( isCompute ) {

		if ( typeof artifact.computeShader !== 'string' ) errors.push( validationError( 'artifact.computeShader', `${ label}: compute artifact is missing computeShader`, 'computeShader' ) );

	} else {

		if ( 'vertexShader' in artifact && typeof artifact.vertexShader !== 'string' ) errors.push( validationError( 'artifact.vertexShader', `${ label}: vertexShader must be a string`, 'vertexShader' ) );
		if ( 'fragmentShader' in artifact && typeof artifact.fragmentShader !== 'string' ) errors.push( validationError( 'artifact.fragmentShader', `${ label}: fragmentShader must be a string`, 'fragmentShader' ) );
		if ( !( 'vertexShader' in artifact ) && !( 'fragmentShader' in artifact ) && opts.requireShaders === true ) {

			errors.push( validationError( 'artifact.shaders', `${ label}: artifact is missing vertexShader/fragmentShader`, '' ) );

		}

	}

	const sourceKinds = [];
	if ( Array.isArray( artifact.uniformPlan ) ) {

		for ( let groupIndex = 0; groupIndex < artifact.uniformPlan.length; groupIndex ++ ) {

			const group = artifact.uniformPlan[ groupIndex ];
			const groupPath = `uniformPlan[${ groupIndex }]`;
			if ( ! group || typeof group !== 'object' || Array.isArray( group ) ) {

				errors.push( validationError( 'uniformPlan.group', `${ label}: ${ groupPath} must be an object`, groupPath ) );
				continue;

			}
			for ( const key of [ 'slots', 'textures', 'storageBuffers' ] ) {

				if ( group[ key ] !== undefined && ! Array.isArray( group[ key ] ) ) {

					errors.push( validationError( `uniformPlan.${ key }`, `${ label}: ${ groupPath}.${ key } must be an array when present`, `${ groupPath}.${ key }` ) );

				}

			}
			const lists = [
				[ 'slots', group.slots ],
				[ 'textures', group.textures ],
			];
			for ( const [ listName, list ] of lists ) {

				if ( ! Array.isArray( list ) ) continue;
				for ( let itemIndex = 0; itemIndex < list.length; itemIndex ++ ) {

					const item = list[ itemIndex ];
					const source = item && item.source;
					const kind = source && source.kind;
					if ( kind === undefined ) continue;
					const itemPath = `${ groupPath}.${ listName }[${ itemIndex }].source.kind`;
					if ( typeof kind !== 'string' || kind.length === 0 ) {

						errors.push( validationError( 'source.kind.type', `${ label}: ${ itemPath } must be a non-empty string`, itemPath ) );
						continue;

					}
					sourceKinds.push( kind );
					if ( ! isKnownKind( kind ) ) {

						errors.push( validationError( 'source.kind.unknown', `${ label}: unknown source.kind "${ kind }" at ${ itemPath }`, itemPath ) );

					}

				}

			}

		}

	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		sourceKinds: Object.freeze( [ ...new Set( sourceKinds ) ].sort() ),
	};

}

export function assertValidArtifact( input, opts = {} ) {

	const result = validateArtifact( input, opts );
	if ( ! result.ok ) {

		const message = result.errors.map( ( error ) => error.message ).join( '\n' );
		throw new Error( message );

	}
	return input;

}
