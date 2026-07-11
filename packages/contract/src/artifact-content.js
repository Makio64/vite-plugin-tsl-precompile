const ROOT_METADATA_FIELDS = new Set( [
	'__hash',
	'__name',
	'captureClock',
	'materialUuid',
	'sourceGraphHash',
	'sourceHashVersion',
	'sourceMaterial',
	'sourceThreeVersion',
	'userMaterialUuid',
] );

export const ARTIFACT_CONTENT_HASH_VERSION = 'artifact-content@2';

/**
 * Canonical payload for the hard artifact identity gate.
 *
 * Unlike a source fingerprint, this includes the emitted shaders, binding
 * layout, uniform plan, render state, and every captured variant. Capture-only
 * provenance is excluded so the same runtime payload remains content-addressed
 * across sessions.
 */
export function createArtifactContentHashPayload( artifact, opts = {} ) {

	const shape = opts.shape;
	const threeVersion = opts.threeVersion;
	const toolchainVersion = opts.toolchainVersion ?? opts.pluginVersion;
	if ( typeof shape !== 'string' || shape.length === 0 ) throw new TypeError( 'createArtifactContentHashPayload: "shape" must be a non-empty string' );
	if ( typeof threeVersion !== 'string' || threeVersion.length === 0 ) throw new Error( 'createArtifactContentHashPayload: "threeVersion" is required' );
	if ( typeof toolchainVersion !== 'string' || toolchainVersion.length === 0 ) throw new Error( 'createArtifactContentHashPayload: "toolchainVersion" is required' );

	return [
		ARTIFACT_CONTENT_HASH_VERSION,
		`shape=${ JSON.stringify( shape ) }`,
		`three=${ JSON.stringify( threeVersion ) }`,
		`toolchain=${ JSON.stringify( toolchainVersion ) }`,
		stableArtifactValue( artifact, new Set() ),
	].join( '\n' );

}

function stableArtifactValue( value, seen ) {

	if ( value === null ) return 'null';
	if ( typeof value === 'number' ) {

		if ( Number.isNaN( value ) ) return '"<NaN>"';
		if ( value === Infinity ) return '"<Infinity>"';
		if ( value === - Infinity ) return '"<-Infinity>"';
		if ( Object.is( value, - 0 ) ) return '"<-0>"';
		return JSON.stringify( value );

	}
	if ( typeof value === 'string' || typeof value === 'boolean' ) return JSON.stringify( value );
	if ( value === undefined ) return '"<undefined>"';
	if ( typeof value !== 'object' ) return JSON.stringify( `<${ typeof value }>` );
	if ( seen.has( value ) ) return '"<cycle>"';
	seen.add( value );

	let result;
	if ( Array.isArray( value ) ) {

		result = `[${ value.map( ( item ) => stableArtifactValue( item, seen ) ).join( ',' ) }]`;

	} else {

		const keys = Object.keys( value )
			.filter( ( key ) => ! key.startsWith( '_' ) && ! ROOT_METADATA_FIELDS.has( key ) )
			.sort();
		result = `{${ keys.map( ( key ) => `${ JSON.stringify( key ) }:${ stableArtifactValue( value[ key ], seen ) }` ).join( ',' ) }}`;

	}
	seen.delete( value );
	return result;

}
