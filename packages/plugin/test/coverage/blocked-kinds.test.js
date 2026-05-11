import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DOCUMENTED_BLOCKED_KINDS } from '../../src/emit-updater.js';
import { generateForPlan } from './_helpers.js';

test( 'documented-blocked source kinds report severity=blocked when misrouted into UBO slots', () => {

	for ( const kind of Object.keys( DOCUMENTED_BLOCKED_KINDS ) ) {

		const result = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind } } ] } ] } );
		assert.equal( result.unsupportedKinds.length, 1, `expected one unsupported entry for ${ kind }` );
		assert.equal( result.unsupportedKinds[ 0 ].kind, kind );
		assert.equal( result.unsupportedKinds[ 0 ].severity, 'blocked' );
		assert.match( result.unsupportedKinds[ 0 ].reason, /\S/ );

	}

} );
