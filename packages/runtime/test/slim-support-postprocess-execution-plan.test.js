import test from 'node:test';
import assert from 'node:assert/strict';

import { attachLiveNodeDependency } from '../src/slim-support/node-dependencies.js';
import {
	createPostprocessExecutionPlan,
	postprocessGraphContains,
} from '../src/slim-support/postprocess-execution-plan.js';

test( 'registered execution metadata creates the conservative GTAO to TRAA wave', () => {

	const prePass = { name: 'pre-pass' };
	const gtao = { name: 'gtao' };
	const contextNode = {};
	attachLiveNodeDependency( contextNode, { gtao } );
	const scenePass = { name: 'scene-pass', contextNode };
	const traa = { name: 'traa' };
	const plan = createPostprocessExecutionPlan( {
		passNodes: [ scenePass, prePass ],
		outputNode: { scenePass, prePass, traa },
		collectEffects: () => [
			{ handler: { name: 'gtao', execution: { phase: 'pass-context', getProducerPasses: () => [ prePass ] } }, node: gtao },
			{ handler: { name: 'traa', execution: { phase: 'terminal' } }, node: traa },
		],
	} );

	assert.equal( plan.supported, true );
	assert.deepEqual( plan.producerPasses, [ prePass ] );
	assert.deepEqual( plan.contextEffects.map( ( match ) => match.node ), [ gtao ] );
	assert.deepEqual( plan.consumerPasses, [ scenePass ] );
	assert.deepEqual( plan.terminalEffects.map( ( match ) => match.node ), [ traa ] );
	assert.deepEqual( plan.unplacedPasses, [] );
	assert.deepEqual( plan.issues, [] );

} );

test( 'registered execution plan declines a context wave without a producer', () => {

	const effect = {};
	const passNode = { effect };
	const plan = createPostprocessExecutionPlan( {
		passNodes: [ passNode ],
		outputNode: passNode,
		collectEffects: () => [ { handler: { name: 'effect', execution: { phase: 'pass-context', getProducerPasses: () => [] } }, node: effect } ],
	} );
	assert.equal( plan.supported, false );
	assert.match( plan.issues.join( '\n' ), /no declared producer pass/ );

} );

test( 'registered execution plan declines unplaced passes instead of guessing producers', () => {

	const producer = {};
	const effect = {};
	const consumer = { effect };
	const unplaced = {};
	const plan = createPostprocessExecutionPlan( {
		passNodes: [ producer, consumer, unplaced ],
		outputNode: consumer,
		collectEffects: () => [ {
			handler: { name: 'effect', execution: { phase: 'pass-context', getProducerPasses: () => [ producer ] } },
			node: effect,
		} ],
	} );
	assert.equal( plan.supported, false );
	assert.deepEqual( plan.unplacedPasses, [ unplaced ] );
	assert.match( plan.issues.join( '\n' ), /unplaced pass/ );

} );

test( 'postprocess graph containment is cycle-safe and follows explicit dependencies', () => {

	const root = {};
	const middle = {};
	const target = {};
	root.middle = middle;
	middle.root = root;
	attachLiveNodeDependency( middle, { target } );
	assert.equal( postprocessGraphContains( root, target ), true );
	assert.equal( postprocessGraphContains( root, {} ), false );

} );
