/**
 * AOT updater codegen.
 *
 * Takes a `uniformPlan` (produced by the vendored `extractUniformPlan.js`)
 * and emits a static ES module that writes UBO bytes directly — the
 * performance-critical core of the proposal.
 *
 * Each generated module exports a single function:
 *
 *   export function update(frame, material, view, byteOffset) {
 *     // byteOffset is the UBO's base offset in the staging buffer
 *     writeMat4(view, byteOffset + 0,   frame.camera.projectionMatrix);
 *     writeMat4(view, byteOffset + 64,  frame.camera.viewMatrix);
 *     writeColor(view, byteOffset + 192, material.color);
 *     ...
 *   }
 *
 * Source kinds handled (Phase 3 minimum — expand per coverage matrix):
 *   - camera.projectionMatrix, camera.viewMatrix, camera.worldMatrix, camera.near, camera.far
 *   - object.worldMatrix, object.worldMatrixInverse, object.normalMatrix
 *   - material.<property>  (color, opacity, roughness, metalness, emissive, etc.)
 *   - time, deltaTime, frameId
 *   - uniform.live          (reads material-attached live value)
 *   - uniform.constant      (inlined literal)
 *
 * Unsupported kinds emit a `throw new Error(...)` line AND an exported
 * `__unsupportedKinds` array so the plugin can surface them to the author
 * at build time (the "loud failure" gate from ARCHITECTURE.md).
 *
 * @module EmitUpdater
 */

/**
 * Generate the source text of an updater module for a single artifact.
 *
 * @param {Object} artifact - Output of the vendored `extractArtifact()`.
 * @param {Object} [opts]
 * @param {string} [opts.writersImport='@tsl-precompile/runtime/writers'] - Import specifier for the writers module.
 * @return {{ source: string, unsupportedKinds: string[] }}
 */
export function emitUpdaterSource( artifact, opts = {} ) {

	const writersImport = opts.writersImport || '@tsl-precompile/runtime/writers';
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];

	const lines = [];
	const usedWriters = new Set();
	const unsupportedKinds = [];
	const constants = [];

	for ( const group of plan ) {

		if ( ! Array.isArray( group.slots ) ) continue;

		lines.push( `  // bind group ${ JSON.stringify( group.name || '' ) }` );

		for ( const slot of group.slots ) {

			const writer = emitSlotWrite( slot, usedWriters, constants, unsupportedKinds );
			lines.push( '  ' + writer );

		}

	}

	const writerImports = Array.from( usedWriters ).sort();
	const constantDecls = constants.length > 0 ? constants.join( '\n' ) + '\n\n' : '';

	const header = writerImports.length > 0
		? `import { ${ writerImports.join( ', ' ) } } from ${ JSON.stringify( writersImport ) };\n\n`
		: '';

	const body = [
		header,
		constantDecls,
		`export function update(frame, material, view, byteOffset) {\n`,
		lines.join( '\n' ),
		`\n}\n`,
		`\nexport const __unsupportedKinds = ${ JSON.stringify( unsupportedKinds ) };\n`,
	].join( '' );

	return { source: body, unsupportedKinds };

}

/**
 * Emit the single line that writes one UBO slot.
 *
 * @param {Object} slot
 * @param {Set<string>} usedWriters - Mutated with writer names encountered.
 * @param {Array<string>} constants - Mutated with any top-of-file const declarations needed.
 * @param {Array<string>} unsupportedKinds - Mutated with kinds we can't emit.
 * @return {string}
 */
function emitSlotWrite( slot, usedWriters, constants, unsupportedKinds ) {

	const byteOffset = slot.byteOffset | 0;
	const src = slot.source || {};
	const kind = src.kind || 'unknown';

	const off = `byteOffset + ${ byteOffset }`;

	switch ( kind ) {

		case 'camera.projectionMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.projectionMatrix);`;

		case 'camera.viewMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.matrixWorldInverse);`;

		case 'camera.worldMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.matrixWorld);`;

		case 'camera.position':
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, frame.camera.position);`;

		case 'camera.near':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.camera.near);`;

		case 'camera.far':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.camera.far);`;

		case 'object.worldMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.object.matrixWorld);`;

		case 'object.worldMatrixInverse':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.object._worldMatrixInverse);`;

		case 'object.normalMatrix':
			usedWriters.add( 'writeMat3' );
			return `writeMat3(view, ${ off }, frame.object.normalMatrix);`;

		case 'object.modelViewMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.object.modelViewMatrix);`;

		case 'time':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.time);`;

		case 'deltaTime':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.deltaTime);`;

		case 'frameId':
			usedWriters.add( 'writeU32' );
			return `writeU32(view, ${ off }, frame.frameId);`;

		case 'material.color':
		case 'material.emissive':
		case 'material.specular':
		case 'material.sheenColor':
		case 'material.attenuationColor': {

			const prop = src.property || kind.split( '.' )[ 1 ];
			usedWriters.add( 'writeColor' );
			return `writeColor(view, ${ off }, material.${ prop });`;

		}

		case 'material.scalar':
		case 'material.opacity':
		case 'material.roughness':
		case 'material.metalness':
		case 'material.ior':
		case 'material.clearcoat':
		case 'material.clearcoatRoughness':
		case 'material.sheen':
		case 'material.sheenRoughness':
		case 'material.transmission':
		case 'material.thickness':
		case 'material.iridescence':
		case 'material.iridescenceIOR':
		case 'material.anisotropy':
		case 'material.dispersion':
		case 'material.reflectivity': {

			const prop = src.property || kind.split( '.' )[ 1 ];
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, material.${ prop });`;

		}

		case 'uniform.constant': {

			// Inline the captured value as a literal — no runtime read.
			return emitConstant( slot, off, usedWriters, constants );

		}

		case 'uniform.live': {

			// Live uniform — material carries a refresh callback that feeds a
			// Vector3/Color/etc. The transform captured `property` pointing at
			// the live holder on the material.
			const prop = src.property;
			if ( ! prop ) {

				unsupportedKinds.push( kind + ' (missing property)' );
				return `throw new Error("[tsl-precompile] unsupported uniform.live: missing property");`;

			}

			const writer = inferWriterForValueType( src.valueType );
			if ( ! writer ) {

				unsupportedKinds.push( `${ kind } (unknown valueType ${ src.valueType })` );
				return `throw new Error("[tsl-precompile] unsupported uniform.live valueType ${ src.valueType }");`;

			}
			usedWriters.add( writer );
			return `${ writer }(view, ${ off }, material.${ prop });`;

		}

		default: {

			unsupportedKinds.push( kind );
			return `throw new Error("[tsl-precompile] unsupported source.kind: ${ kind }");`;

		}

	}

}

function emitConstant( slot, off, usedWriters, constants ) {

	const { valueType, value } = slot.source;
	const idx = constants.length;
	const varName = `__const${ idx }`;

	switch ( valueType ) {

		case 'f32':
		case 'float':
			constants.push( `const ${ varName } = ${ Number( value ) };` );
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, ${ varName });`;

		case 'vec2':
			constants.push( `const ${ varName } = { x: ${ value[ 0 ] }, y: ${ value[ 1 ] } };` );
			usedWriters.add( 'writeVec2' );
			return `writeVec2(view, ${ off }, ${ varName });`;

		case 'vec3':
			constants.push( `const ${ varName } = { x: ${ value[ 0 ] }, y: ${ value[ 1 ] }, z: ${ value[ 2 ] } };` );
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, ${ varName });`;

		case 'vec4':
			constants.push( `const ${ varName } = { x: ${ value[ 0 ] }, y: ${ value[ 1 ] }, z: ${ value[ 2 ] }, w: ${ value[ 3 ] } };` );
			usedWriters.add( 'writeVec4' );
			return `writeVec4(view, ${ off }, ${ varName });`;

		case 'color':
			constants.push( `const ${ varName } = { r: ${ value[ 0 ] }, g: ${ value[ 1 ] }, b: ${ value[ 2 ] } };` );
			usedWriters.add( 'writeColor' );
			return `writeColor(view, ${ off }, ${ varName });`;

		default:
			// Fall through to unsupported handling at call site.
			return `throw new Error("[tsl-precompile] unsupported uniform.constant valueType: ${ valueType }");`;

	}

}

function inferWriterForValueType( valueType ) {

	switch ( valueType ) {

		case 'f32': case 'float': return 'writeF32';
		case 'i32': case 'int': return 'writeI32';
		case 'u32': case 'uint': return 'writeU32';
		case 'vec2': return 'writeVec2';
		case 'vec3': return 'writeVec3';
		case 'vec4': return 'writeVec4';
		case 'color': return 'writeColor';
		case 'mat3': return 'writeMat3';
		case 'mat4': return 'writeMat4';
		default: return null;

	}

}
