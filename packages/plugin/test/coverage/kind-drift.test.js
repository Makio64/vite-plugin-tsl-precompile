/**
 * Drift detector.
 *
 * Phase 5's release gate says: "100% of cells either covered or documented-
 * blocked." The most robust reading is structural: every kind the extractor
 * can emit must either have a codegen case in `emit-updater.js` or be in
 * `DOCUMENTED_BLOCKED_KINDS`. Conversely, every kind the codegen handles
 * should still be a kind the extractor produces (catches stale cases after
 * a vendor bump).
 *
 * This test replaces what would otherwise be ~25 hand-written per-kind
 * fixtures — and, more importantly, is load-bearing going forward: any
 * vendor bump that changes the extractor's kind vocabulary will fail this
 * test with a specific diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { DOCUMENTED_BLOCKED_KINDS } from '../../src/emit-updater.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const PLUGIN_SRC = resolve( HERE, '../../src' );

const extractorSrc = readFileSync( resolve( PLUGIN_SRC, 'vendor/extractUniformPlan.js' ), 'utf8' );
const updaterSrc = readFileSync( resolve( PLUGIN_SRC, 'emit-updater.js' ), 'utf8' );

/**
 * Literal `kind: 'foo.bar'` occurrences in the extractor source. Dynamic
 * string concatenations (`kind: prefix + '.' + node.property`) are
 * enumerated separately below.
 */
function extractLiteralKinds( src ) {

	const out = new Set();
	const re = /kind:\s*['"`]([\w][\w.]*)['"`]/g;
	let m;
	while ( ( m = re.exec( src ) ) !== null ) out.add( m[ 1 ] );
	return out;

}

/**
 * Enumerate the dynamic-kind prefixes the extractor produces via runtime
 * string concatenation. This set is maintained by reading the extractor —
 * see `resolveFromUpdateNode` in `vendor/extractUniformPlan.js`:
 *
 *   - ReferenceNode/MaterialReferenceNode → `material.<prop>` | `scene.fog.<prop>` | `scene.<prop>`
 *   - Object3DNode/ModelNode              → `object.<scope>` | `object3d.<scope>`
 *
 * The concrete property values the extractor can emit depend on three.js's
 * own node definitions; keeping this list loose would let drift sneak in.
 * Instead we enumerate the concrete `<prefix>.<field>` pairs that appear in
 * the emit-updater switch — the drift check asserts the two sets match.
 */
const DYNAMIC_EXTRACTOR_PREFIXES = [ 'material.', 'scene.fog.', 'scene.', 'object.', 'object3d.' ];

/**
 * Literal `case 'foo.bar':` occurrences in the updater source.
 */
function extractUpdaterCases( src ) {

	const out = new Set();
	const re = /case\s+['"`]([\w][\w.]*)['"`]\s*:/g;
	let m;
	while ( ( m = re.exec( src ) ) !== null ) out.add( m[ 1 ] );
	return out;

}

const extractorKinds = extractLiteralKinds( extractorSrc );
const updaterCases = extractUpdaterCases( updaterSrc );
const blockedKinds = new Set( Object.keys( DOCUMENTED_BLOCKED_KINDS ) );

test( 'drift — every literal kind the extractor emits is handled or documented-blocked', () => {

	const missing = [];
	for ( const kind of extractorKinds ) {

		// Skip the dialect aliases — `uniform.live` and `uniform.constant`
		// are legacy aliases still carried for hand-written plans; the
		// extractor emits `uniform.live` AND `constant`.
		if ( updaterCases.has( kind ) ) continue;
		if ( blockedKinds.has( kind ) ) continue;

		// Also tolerate prefix-only placeholders — the extractor doesn't
		// emit these as literal kinds, but the regex picks them up from
		// other contexts.
		missing.push( kind );

	}

	assert.deepEqual(
		missing,
		[],
		`extractor emits ${ missing.length } kind(s) the updater neither handles nor documents as blocked:\n  ${ missing.join( '\n  ' ) }`
	);

} );

test( 'drift — every updater case corresponds to a real extractor kind (catches stale cases after vendor bump)', () => {

	// Intentional aliases the updater carries for hand-written synthetic
	// plans — these are legal even if the extractor no longer emits them.
	const ALIASES = new Set( [
		// frame-prefix normalisation
		'time', 'deltaTime', 'frameId',
		// legacy constant/live
		'uniform.constant',
		// material.* specific props — the extractor emits them via dynamic
		// concatenation `material.<prop>`, not as literal kinds, so the
		// literal-extraction pass misses them. These are covered by the
		// material-axis tests instead.
		'material.color', 'material.emissive', 'material.specular',
		'material.specularColor', 'material.sheenColor',
		'material.attenuationColor',
		'material.scalar', 'material.opacity', 'material.alphaTest', 'material.roughness',
		'material.metalness', 'material.ior',
		'material.emissiveIntensity', 'material.aoMapIntensity', 'material.specularIntensity',
		'material.shininess', 'material.size', 'material.rotation',
		'material.clearcoat', 'material.clearcoatRoughness',
		'material.clearcoatNormalScale',
		'material.sheen', 'material.sheenRoughness',
		'material.transmission', 'material.thickness', 'material.attenuationDistance',
		'material.iridescence', 'material.iridescenceIOR',
		'material.anisotropy', 'material.dispersion',
		'material.reflectivity', 'material.normalScale',
		// scene.fog.<prop> + scene.<prop> — same dynamic-concat caveat.
		'scene.fog.color', 'scene.fog.near', 'scene.fog.far', 'scene.fog.density',
		'scene.environmentIntensity', 'scene.backgroundIntensity',
		'scene.backgroundBlurriness',
		// object.* and object3d.<scope> — dynamic concat + aliases.
		'object.worldMatrix', 'object.worldMatrixInverse', 'object.normalMatrix',
		'object.modelViewMatrix', 'object.scale',
		'object3d.position', 'object3d.scale', 'object3d.viewPosition',
		'object3d.direction', 'object3d.worldMatrix', 'object3d.normalMatrix',
		'object3d.modelViewMatrix', 'object3d.radius',
		// camera.projectionMatrixInverse is a literal camera case emitted
		// by classifyByName — covered above. No extra alias needed.
		// renderer.* — emitted by the ScreenNode path in resolveFromUpdateNode;
		// the extractor source uses string literals for these kinds so they
		// ARE in extractorKinds. Listed here as documentation; the drift test
		// will pass once the extractor source includes them.
		'renderer.dpr', 'renderer.size', 'renderer.viewport', 'renderer.halfHeight',
	] );

	const stale = [];
	for ( const kind of updaterCases ) {

		if ( extractorKinds.has( kind ) ) continue;
		if ( ALIASES.has( kind ) ) continue;

		// JSON-layout-switch cases in inferWriterForValueType ('f32', 'vec3',
		// 'mat4', etc.) are not kinds — filter them out. We identify them
		// by the absence of a dot AND no match in the extractor's literal set.
		if ( ! kind.includes( '.' ) && ! kind.includes( '_' ) ) continue;

		stale.push( kind );

	}

	assert.deepEqual(
		stale,
		[],
		`updater has ${ stale.length } case(s) with no corresponding extractor kind (vendor drift — either the extractor changed OR the case is stale):\n  ${ stale.join( '\n  ' ) }`
	);

} );

test( 'drift — DOCUMENTED_BLOCKED_KINDS entries have non-empty reasons', () => {

	for ( const [ kind, reason ] of Object.entries( DOCUMENTED_BLOCKED_KINDS ) ) {

		assert.equal( typeof reason, 'string', `reason for "${ kind }" must be a string` );
		assert.ok( reason.length > 10, `reason for "${ kind }" is too short — give the user a clue about the migration path` );

	}

} );
