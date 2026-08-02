/**
 * Variant-local light identity records shared by capture, codegen, and replay.
 *
 * `Object3D.id` is deliberately absent: it is process-local. `captureIndex`
 * records the captured light order only, while `explicitKey`, `name`, `type`,
 * and the snapshot provide durable replay evidence.
 */

import { collectArtifactDynamicBindings } from './dynamic-bindings.js';

export const LIGHT_IDENTITY_SCHEMA = 'light-identity@1';

/**
 * Symbol sidecar used between the live extractor and artifact normalization.
 * Symbol keys survive object spread but are ignored by JSON.stringify, so a
 * complete capture record never has to be duplicated into every source.
 */
export const LIGHT_IDENTITY_CAPTURE = Symbol.for( '@tsl-precompile/contract/light-identity-capture@1' );

export const LIGHT_IDENTITY_SNAPSHOT_FIELDS = Object.freeze( [
	'position',
	'targetPosition',
	'color',
	'intensity',
	'distance',
	'decay',
	'angle',
	'penumbra',
	'width',
	'height',
	'castShadow',
	'shadowType',
	'cameraType',
] );

const LIGHT_IDENTITY_SNAPSHOT_FIELD_SET = new Set( LIGHT_IDENTITY_SNAPSHOT_FIELDS );

function nonEmptyString( value ) {

	return typeof value === 'string' && value.length > 0 ? value : null;

}

function compareStrings( a, b ) {

	const left = String( a || '' );
	const right = String( b || '' );
	return left < right ? - 1 : left > right ? 1 : 0;

}

function objectType( value ) {

	return nonEmptyString( value && value.type )
		|| nonEmptyString( value && value.constructor && ( value.constructor.type || value.constructor.name ) );

}

function finiteNumber( value ) {

	return Number.isFinite( value ) ? Number( value ) : null;

}

function vector3Snapshot( value ) {

	if ( ! value ) return null;
	if ( Array.isArray( value ) && value.length >= 3 ) {

		const out = value.slice( 0, 3 ).map( finiteNumber );
		return out.every( ( item ) => item !== null ) ? out : null;

	}
	const out = [ finiteNumber( value.x ), finiteNumber( value.y ), finiteNumber( value.z ) ];
	return out.every( ( item ) => item !== null ) ? out : null;

}

function colorSnapshot( value ) {

	if ( ! value ) return null;
	if ( Array.isArray( value ) && value.length >= 3 ) {

		const out = value.slice( 0, 3 ).map( finiteNumber );
		return out.every( ( item ) => item !== null ) ? out : null;

	}
	const out = [ finiteNumber( value.r ), finiteNumber( value.g ), finiteNumber( value.b ) ];
	return out.every( ( item ) => item !== null ) ? out : null;

}

function worldPositionSnapshot( value ) {

	const elements = value && value.matrixWorld && value.matrixWorld.elements;
	if ( elements && elements.length >= 16 ) {

		const out = [ finiteNumber( elements[ 12 ] ), finiteNumber( elements[ 13 ] ), finiteNumber( elements[ 14 ] ) ];
		if ( out.every( ( item ) => item !== null ) ) return out;

	}
	return vector3Snapshot( value && value.position );

}

function explicitLightKey( light ) {

	const value = light && light.userData && light.userData.tslPrecompileId;
	if ( typeof value === 'string' && value.length > 0 ) return value;
	if ( Number.isFinite( value ) ) return String( value );
	return null;

}

function assignDefined( target, key, value ) {

	if ( value !== null && value !== undefined ) target[ key ] = value;

}

/**
 * Capture complete, graph-free matching evidence from a live Three light.
 * This reads public Light/LightShadow properties only.
 */
export function createCapturedLightIdentity( light, captureIndex ) {

	const snapshot = {};
	assignDefined( snapshot, 'position', worldPositionSnapshot( light ) );
	assignDefined( snapshot, 'targetPosition', worldPositionSnapshot( light && light.target ) );
	assignDefined( snapshot, 'color', colorSnapshot( light && light.color ) );
	for ( const key of [ 'intensity', 'distance', 'decay', 'angle', 'penumbra', 'width', 'height' ] ) {

		assignDefined( snapshot, key, finiteNumber( light && light[ key ] ) );

	}
	if ( light && typeof light.castShadow === 'boolean' ) snapshot.castShadow = light.castShadow;
	assignDefined( snapshot, 'shadowType', objectType( light && light.shadow ) );
	assignDefined( snapshot, 'cameraType', objectType( light && light.shadow && light.shadow.camera ) );

	const record = {
		schema: LIGHT_IDENTITY_SCHEMA,
		captureUuid: nonEmptyString( light && light.uuid ),
		captureIndex: Number.isInteger( captureIndex ) && captureIndex >= 0 ? captureIndex : 0,
		type: objectType( light ),
		snapshot,
	};
	assignDefined( record, 'explicitKey', explicitLightKey( light ) );
	assignDefined( record, 'name', nonEmptyString( light && light.name ) );
	return record;

}

/**
 * Source metadata for the vendored extractor. The complete identity rides on
 * a Symbol sidecar until the artifact-level table is assembled.
 */
export function createLightSourceIdentityMetadata( light, captureIndex ) {

	const metadata = {
		lightIndex: Number.isInteger( captureIndex ) ? captureIndex : 0,
		lightUuid: nonEmptyString( light && light.uuid ),
	};
	Object.defineProperty( metadata, LIGHT_IDENTITY_CAPTURE, {
		value: createCapturedLightIdentity( light, captureIndex ),
		enumerable: true,
		configurable: true,
	} );
	return metadata;

}

function isOwnedLightSource( source ) {

	if ( ! source || typeof source !== 'object' ) return false;
	if ( typeof source.kind === 'string' && source.kind.startsWith( 'light.' ) ) return true;
	return source.kind === 'depth.texture' && Number.isInteger( source.lightIndex ) && source.lightIndex >= 0;

}

function sourceSnapshot( source ) {

	const snapshot = source && source.valueSnapshot;
	const data = snapshot && snapshot.data;
	const out = {};
	if ( ! source || data === undefined ) return out;
	switch ( source.kind ) {

		case 'light.position':
			assignDefined( out, 'position', vector3Snapshot( data ) );
			break;
		case 'light.targetPosition':
			assignDefined( out, 'targetPosition', vector3Snapshot( data ) );
			break;
		case 'light.distance':
			assignDefined( out, 'distance', finiteNumber( data ) );
			break;
		case 'light.decay':
			assignDefined( out, 'decay', finiteNumber( data ) );
			break;
		case 'light.coneCos': {

			const coneCos = finiteNumber( data );
			if ( coneCos !== null && coneCos >= - 1 && coneCos <= 1 ) out.angle = Math.acos( coneCos );
			break;

		}

	}
	return out;

}

function cleanSnapshot( snapshot ) {

	const out = {};
	if ( ! snapshot || typeof snapshot !== 'object' || Array.isArray( snapshot ) ) return out;
	for ( const key of LIGHT_IDENTITY_SNAPSHOT_FIELDS ) {

		const value = snapshot[ key ];
		if ( value === undefined || value === null ) continue;
		if ( key === 'position' || key === 'targetPosition' ) assignDefined( out, key, vector3Snapshot( value ) );
		else if ( key === 'color' ) assignDefined( out, key, colorSnapshot( value ) );
		else if ( key === 'castShadow' ) {

			if ( typeof value === 'boolean' ) out[ key ] = value;

		} else if ( key === 'shadowType' || key === 'cameraType' ) assignDefined( out, key, nonEmptyString( value ) );
		else assignDefined( out, key, finiteNumber( value ) );

	}
	return out;

}

function cleanRecord( record, fallbackIndex ) {

	const out = {
		schema: LIGHT_IDENTITY_SCHEMA,
		captureUuid: nonEmptyString( record && record.captureUuid ),
		captureIndex: Number.isInteger( record && record.captureIndex ) && record.captureIndex >= 0
			? record.captureIndex
			: fallbackIndex,
		type: nonEmptyString( record && record.type ),
		snapshot: cleanSnapshot( record && record.snapshot ),
	};
	assignDefined( out, 'explicitKey', nonEmptyString( record && record.explicitKey ) );
	assignDefined( out, 'name', nonEmptyString( record && record.name ) );
	return out;

}

function mergeRecord( target, candidate, overwrite = false ) {

	if ( ! candidate || typeof candidate !== 'object' ) return;
	for ( const key of [ 'captureUuid', 'captureIndex', 'type', 'explicitKey', 'name' ] ) {

		const value = candidate[ key ];
		if ( value !== undefined && value !== null && value !== '' && ( overwrite || target[ key ] === undefined || target[ key ] === null ) ) target[ key ] = value;

	}
	const snapshot = cleanSnapshot( candidate.snapshot );
	for ( const [ key, value ] of Object.entries( snapshot ) ) {

		if ( overwrite || target.snapshot[ key ] === undefined ) target.snapshot[ key ] = value;

	}

}

function sourceIdentityEvidence( source, table ) {

	const stored = Number.isInteger( source.lightIdentity ) && Array.isArray( table ) ? table[ source.lightIdentity ] : null;
	const captured = source[ LIGHT_IDENTITY_CAPTURE ] || null;
	const fallback = {
		captureUuid: nonEmptyString( source.lightUuid ),
		captureIndex: Number.isInteger( source.lightIndex ) && source.lightIndex >= 0 ? source.lightIndex : null,
		type: nonEmptyString( source.lightType ),
		explicitKey: nonEmptyString( source.lightExplicitKey ),
		name: nonEmptyString( source.lightName ),
		snapshot: sourceSnapshot( source ),
	};
	return { stored, captured, fallback };

}

function visitPlanSources( plan, visit ) {

	const seenItems = new Set();
	for ( const group of Array.isArray( plan ) ? plan : [] ) {

		const visitItem = ( item ) => {

			if ( ! item || typeof item !== 'object' || seenItems.has( item ) ) return;
			seenItems.add( item );
			if ( isOwnedLightSource( item.source ) ) visit( item.source );

		};
		const slots = Array.isArray( group?.slots ) ? group.slots : [];
		const textures = Array.isArray( group?.textures ) ? group.textures : [];
		const orderedBindings = Array.isArray( group?.orderedBindings ) ? group.orderedBindings : [];
		for ( const item of slots ) visitItem( item );
		for ( const item of textures ) visitItem( item );
		for ( const binding of orderedBindings ) {

			visitItem( binding && binding.ref );
			const bindingSlots = Array.isArray( binding?.slots ) ? binding.slots : [];
			for ( const item of bindingSlots ) visitItem( item );

		}

	}

}

function cloneWithProperties( value, overrides = null, omittedSymbols = [] ) {

	const descriptors = Object.getOwnPropertyDescriptors( value );
	for ( const symbol of omittedSymbols ) delete descriptors[ symbol ];
	if ( overrides ) {

		for ( const [ key, item ] of Object.entries( overrides ) ) descriptors[ key ] = {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true,
		};

	}
	return Object.defineProperties( Object.create( Object.getPrototypeOf( value ) ), descriptors );

}

function cloneUniformPlan( plan, sourceToIdentity ) {

	const itemClones = new Map();
	const cloneItem = ( item ) => {

		if ( ! item || typeof item !== 'object' ) return item;
		if ( itemClones.has( item ) ) return itemClones.get( item );
		let source = item.source;
		const lightIdentity = sourceToIdentity.get( source );
		if ( lightIdentity !== undefined ) source = cloneWithProperties( source, { lightIdentity }, [ LIGHT_IDENTITY_CAPTURE ] );
		const clone = source === item.source ? item : cloneWithProperties( item, { source } );
		itemClones.set( item, clone );
		return clone;

	};
	return plan.map( ( group ) => {

		if ( ! group || typeof group !== 'object' ) return group;
		const overrides = {};
		if ( Array.isArray( group.slots ) ) overrides.slots = group.slots.map( cloneItem );
		if ( Array.isArray( group.textures ) ) overrides.textures = group.textures.map( cloneItem );
		if ( Array.isArray( group.orderedBindings ) ) overrides.orderedBindings = group.orderedBindings.map( ( binding ) => {

			if ( ! binding || typeof binding !== 'object' ) return binding;
			const bindingOverrides = {};
			if ( binding.ref ) bindingOverrides.ref = cloneItem( binding.ref );
			if ( Array.isArray( binding.slots ) ) bindingOverrides.slots = binding.slots.map( cloneItem );
			return Object.keys( bindingOverrides ).length > 0 ? cloneWithProperties( binding, bindingOverrides ) : binding;

		} );
		return Object.keys( overrides ).length > 0 ? cloneWithProperties( group, overrides ) : group;

	} );

}

/**
 * Return one normalized variant payload. Every light-owned source gets an
 * integer `lightIdentity` reference; legacy UUID/index/snapshot fields remain.
 */
export function normalizeArtifactLightIdentities( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' || ! Array.isArray( artifact.uniformPlan ) ) return artifact;
	const storedTable = Array.isArray( artifact.lightIdentities ) ? artifact.lightIdentities : [];
	const groups = new Map();
	const sourceToGroup = new Map();
	const usedCaptureIndices = new Set();

	visitPlanSources( artifact.uniformPlan, ( source ) => {

		const evidence = sourceIdentityEvidence( source, storedTable );
		const captureIndex = ( evidence.captured && evidence.captured.captureIndex )
			?? ( evidence.stored && evidence.stored.captureIndex )
			?? evidence.fallback.captureIndex;
		const captureUuid = evidence.captured && evidence.captured.captureUuid
			|| evidence.stored && evidence.stored.captureUuid
			|| evidence.fallback.captureUuid;
		const explicitKey = evidence.captured && evidence.captured.explicitKey
			|| evidence.stored && evidence.stored.explicitKey
			|| evidence.fallback.explicitKey;
		let key;
		if ( Number.isInteger( captureIndex ) && captureIndex >= 0 ) key = `index:${ captureIndex }`;
		else if ( captureUuid ) key = `uuid:${ captureUuid }`;
		else if ( explicitKey ) key = `key:${ explicitKey }`;
		else key = 'implicit:0';

		let group = groups.get( key );
		if ( ! group ) {

			group = { schema: LIGHT_IDENTITY_SCHEMA, captureUuid: null, captureIndex: null, type: null, snapshot: {} };
			groups.set( key, group );

		}
		mergeRecord( group, evidence.fallback );
		mergeRecord( group, evidence.stored );
		mergeRecord( group, evidence.captured, true );
		sourceToGroup.set( source, group );
		if ( Number.isInteger( group.captureIndex ) && group.captureIndex >= 0 ) usedCaptureIndices.add( group.captureIndex );

	} );

	if ( groups.size === 0 ) return artifact;
	let nextCaptureIndex = 0;
	for ( const group of groups.values() ) {

		if ( Number.isInteger( group.captureIndex ) && group.captureIndex >= 0 ) continue;
		while ( usedCaptureIndices.has( nextCaptureIndex ) ) nextCaptureIndex ++;
		group.captureIndex = nextCaptureIndex;
		usedCaptureIndices.add( nextCaptureIndex );
		nextCaptureIndex ++;

	}

	const orderedGroups = [ ...groups.values() ].sort( ( a, b ) =>
		a.captureIndex - b.captureIndex
		|| compareStrings( a.captureUuid, b.captureUuid )
		|| compareStrings( a.type, b.type )
	);
	const groupToIndex = new Map();
	const lightIdentities = orderedGroups.map( ( group, index ) => {

		groupToIndex.set( group, index );
		return cleanRecord( group, index );

	} );
	const sourceToIdentity = new Map();
	for ( const [ source, group ] of sourceToGroup ) sourceToIdentity.set( source, groupToIndex.get( group ) );
	const uniformPlan = cloneUniformPlan( artifact.uniformPlan, sourceToIdentity );
	let normalized = cloneWithProperties( artifact, { uniformPlan, lightIdentities } );
	if ( Array.isArray( artifact.dynamicBindings ) ) normalized = cloneWithProperties( normalized, {
		dynamicBindings: collectArtifactDynamicBindings( normalized ),
	} );
	return normalized;

}

/** Normalize a root artifact and every variant independently. */
export function normalizeArtifactLightIdentitiesDeep( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return artifact;
	let normalized = normalizeArtifactLightIdentities( artifact );
	if ( ! artifact.variants || typeof artifact.variants !== 'object' || Array.isArray( artifact.variants ) ) return normalized;
	let changed = false;
	const variants = {};
	for ( const [ key, variant ] of Object.entries( artifact.variants ) ) {

		const next = normalizeArtifactLightIdentitiesDeep( variant );
		variants[ key ] = next;
		if ( next !== variant ) changed = true;

	}
	if ( ! changed ) return normalized;
	return cloneWithProperties( normalized, { variants } );

}

function validSnapshotValue( key, value ) {

	if ( key === 'position' || key === 'targetPosition' || key === 'color' ) return Array.isArray( value ) && value.length === 3 && value.every( Number.isFinite );
	if ( key === 'castShadow' ) return typeof value === 'boolean';
	if ( key === 'shadowType' || key === 'cameraType' ) return typeof value === 'string' && value.length > 0;
	return Number.isFinite( value );

}

/**
 * Validate the light-identity portion of one variant. Returned paths are
 * artifact-relative so the main artifact validator can prefix variant paths.
 */
export function validateArtifactLightIdentities( artifact ) {

	const errors = [];
	const table = artifact && artifact.lightIdentities;
	if ( table !== undefined && ! Array.isArray( table ) ) {

		errors.push( { code: 'artifact.lightIdentities', path: 'lightIdentities', message: 'lightIdentities must be an array when present' } );
		return errors;

	}
	const captureIndices = new Set();
	const captureUuids = new Set();
	const explicitKeys = new Set();
	for ( let index = 0; index < ( table || [] ).length; index ++ ) {

		const record = table[ index ];
		const path = `lightIdentities[${ index }]`;
		if ( ! record || typeof record !== 'object' || Array.isArray( record ) ) {

			errors.push( { code: 'lightIdentity.record', path, message: `${ path } must be an object` } );
			continue;

		}
		if ( record.schema !== LIGHT_IDENTITY_SCHEMA ) errors.push( { code: 'lightIdentity.schema', path: `${ path }.schema`, message: `${ path }.schema must be ${ JSON.stringify( LIGHT_IDENTITY_SCHEMA ) }` } );
		if ( ! Number.isInteger( record.captureIndex ) || record.captureIndex < 0 ) errors.push( { code: 'lightIdentity.captureIndex', path: `${ path }.captureIndex`, message: `${ path }.captureIndex must be a non-negative integer` } );
		else if ( captureIndices.has( record.captureIndex ) ) errors.push( { code: 'lightIdentity.captureIndex.duplicate', path: `${ path }.captureIndex`, message: `${ path }.captureIndex duplicates another record` } );
		else captureIndices.add( record.captureIndex );
		if ( record.captureUuid !== null && ( typeof record.captureUuid !== 'string' || record.captureUuid.length === 0 ) ) errors.push( { code: 'lightIdentity.captureUuid', path: `${ path }.captureUuid`, message: `${ path }.captureUuid must be null or a non-empty string` } );
		else if ( record.captureUuid && captureUuids.has( record.captureUuid ) ) errors.push( { code: 'lightIdentity.captureUuid.duplicate', path: `${ path }.captureUuid`, message: `${ path }.captureUuid duplicates another record` } );
		else if ( record.captureUuid ) captureUuids.add( record.captureUuid );
		if ( record.type !== null && ( typeof record.type !== 'string' || record.type.length === 0 ) ) errors.push( { code: 'lightIdentity.type', path: `${ path }.type`, message: `${ path }.type must be null or a non-empty string` } );
		for ( const key of [ 'explicitKey', 'name' ] ) {

			if ( record[ key ] !== undefined && ( typeof record[ key ] !== 'string' || record[ key ].length === 0 ) ) errors.push( { code: `lightIdentity.${ key }`, path: `${ path }.${ key }`, message: `${ path }.${ key } must be a non-empty string when present` } );

		}
		if ( record.explicitKey && explicitKeys.has( record.explicitKey ) ) errors.push( { code: 'lightIdentity.explicitKey.duplicate', path: `${ path }.explicitKey`, message: `${ path }.explicitKey duplicates another record` } );
		else if ( record.explicitKey ) explicitKeys.add( record.explicitKey );
		if ( ! record.snapshot || typeof record.snapshot !== 'object' || Array.isArray( record.snapshot ) ) errors.push( { code: 'lightIdentity.snapshot', path: `${ path }.snapshot`, message: `${ path }.snapshot must be an object` } );
		else for ( const [ key, value ] of Object.entries( record.snapshot ) ) {

			if ( ! LIGHT_IDENTITY_SNAPSHOT_FIELD_SET.has( key ) ) errors.push( { code: 'lightIdentity.snapshot.field', path: `${ path }.snapshot.${ key }`, message: `${ path }.snapshot.${ key } is not part of ${ LIGHT_IDENTITY_SCHEMA }` } );
			else if ( ! validSnapshotValue( key, value ) ) errors.push( { code: 'lightIdentity.snapshot.value', path: `${ path }.snapshot.${ key }`, message: `${ path }.snapshot.${ key } has an invalid value` } );

		}

	}

	visitPlanSources( artifact && artifact.uniformPlan, ( source ) => {

		const path = findSourcePath( artifact.uniformPlan, source );
		if ( ! Array.isArray( table ) ) {

			if ( source.lightIdentity !== undefined ) errors.push( { code: 'lightIdentity.table.missing', path: `${ path }.lightIdentity`, message: `${ path }.lightIdentity requires artifact.lightIdentities` } );
			return;

		}
		if ( ! Number.isInteger( source.lightIdentity ) || source.lightIdentity < 0 || source.lightIdentity >= table.length ) {

			errors.push( { code: 'lightIdentity.reference', path: `${ path }.lightIdentity`, message: `${ path }.lightIdentity must reference artifact.lightIdentities` } );
			return;

		}
		const record = table[ source.lightIdentity ];
		if ( ! record || typeof record !== 'object' ) return;
		if ( Number.isInteger( source.lightIndex ) && source.lightIndex >= 0 && source.lightIndex !== record.captureIndex ) errors.push( { code: 'lightIdentity.captureIndex.mismatch', path: `${ path }.lightIdentity`, message: `${ path } legacy lightIndex does not match its identity record` } );
		if ( typeof source.lightUuid === 'string' && source.lightUuid.length > 0 && source.lightUuid !== record.captureUuid ) errors.push( { code: 'lightIdentity.captureUuid.mismatch', path: `${ path }.lightIdentity`, message: `${ path } legacy lightUuid does not match its identity record` } );

	} );
	return errors;

}

function findSourcePath( plan, target ) {

	for ( let groupIndex = 0; groupIndex < ( plan || [] ).length; groupIndex ++ ) {

		const group = plan[ groupIndex ];
		for ( const listName of [ 'slots', 'textures' ] ) {

			const list = group && group[ listName ] || [];
			for ( let index = 0; index < list.length; index ++ ) if ( list[ index ] && list[ index ].source === target ) return `uniformPlan[${ groupIndex }].${ listName }[${ index }].source`;

		}

	}
	return 'uniformPlan.source';

}
