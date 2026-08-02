import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';

import { installR185PMREMNodeGuard } from '../src/r185-pmrem-node-guard.js';

function makePMREMNodeClass() {

	return class PMREMNode {

		constructor( sourceTexture ) {

			this._value = sourceTexture;
			this._pmrem = null;
			this._texture = { value: { isTexture: true, name: 'pending-pmrem' } };
			this.generated = null;

		}

		updateBefore() {

			if ( this._value.ready === true ) {

				this.generated ||= { isTexture: true, name: 'generated-pmrem' };
				this._pmrem = this.generated;
				this._texture.value = this.generated;

			}

		}

	};

}

test( 'r185 PMREM guard keeps a pending source on the shader-compatible placeholder', () => {

	const PMREMNode = makePMREMNodeClass();
	const source = { ready: false };
	const node = new PMREMNode( source );

	assert.equal( installR185PMREMNodeGuard( { REVISION: '185', PMREMNode } ), true );
	node.updateBefore( {} );
	assert.equal( node._pmrem, node._texture.value );
	assert.equal( node._pmrem.name, 'pending-pmrem' );

	source.ready = true;
	node.updateBefore( {} );
	assert.equal( node._pmrem, node.generated );
	assert.equal( node._pmrem.name, 'generated-pmrem' );

} );

test( 'r185.1 PMREMNode retries a real CubeTextureLoader-style pending source', () => {

	const source = new THREE.CubeTexture();
	source.image = [];
	const generated = new THREE.Texture( { width: 48, height: 64 } );
	const node = new THREE.PMREMNode( source );
	node._generator = {
		fromCubemap() {

			return { texture: generated };

		},
	};
	const renderer = {};

	assert.equal( installR185PMREMNodeGuard( THREE ), true );
	node.updateBefore( { renderer } );
	assert.equal( node._pmrem, node._texture.value );
	assert.notEqual( node._pmrem, generated );

	source.image = Array.from( { length: 6 }, () => ( { width: 16, height: 16 } ) );
	node.updateBefore( { renderer } );
	assert.equal( node._pmrem, generated );
	assert.equal( node._texture.value, generated );

} );

test( 'r185 PMREM guard retries pending generation and is idempotent', () => {

	const PMREMNode = makePMREMNodeClass();
	const node = new PMREMNode( { ready: false } );
	const three = { REVISION: '185', PMREMNode };

	assert.equal( installR185PMREMNodeGuard( three ), true );
	const installed = PMREMNode.prototype.updateBefore;
	assert.equal( installR185PMREMNodeGuard( three ), true );
	assert.equal( PMREMNode.prototype.updateBefore, installed );

	node.updateBefore( {} );
	const firstPlaceholder = node._pmrem;
	node.updateBefore( {} );
	assert.equal( node._pmrem, firstPlaceholder );
	assert.equal( node.generated, null );

} );

test( 'PMREM guard is revision- and capability-gated', () => {

	const PMREMNode = makePMREMNodeClass();
	const original = PMREMNode.prototype.updateBefore;

	assert.equal( installR185PMREMNodeGuard( { REVISION: '184', PMREMNode } ), false );
	assert.equal( PMREMNode.prototype.updateBefore, original );
	assert.equal( installR185PMREMNodeGuard( { REVISION: '185' } ), false );

} );
