/**
 * Replay-owned update scheduler for hydrated node state.
 *
 * The full Three NodeFrame is a graph-runtime carrier. Slim replay only needs
 * its frame/render/object update cadence plus the live renderer context, so
 * this class preserves that lifecycle without retaining Three's node core.
 */

import { getTemporalFrameState } from './slim-support/temporal-frame.js';

class ReplayNodeFrame {

	constructor() {

		this.t = this.deltaTime = this.f = this.renderId = 0;
		this.updateMap = new WeakMap();
		this.updateBeforeMap = new WeakMap();
		this.updateAfterMap = new WeakMap();
		this.renderer = this.material = this.camera = this.object = this.scene = null;

	}

	get time() {

		return getTemporalFrameState( this )?.time ?? this.t;

	}

	set time( value ) {

		this.t = value;

	}

	get frameId() {

		return getTemporalFrameState( this )?.frameId ?? this.f;

	}

	set frameId( value ) {

		this.f = value;

	}

	u( node, suffix = '' ) {

		const method = 'update' + suffix;
		const updateType = node[ 'getUpdate' + suffix + 'Type' ]();
		const reference = node.updateReference( this );
		if ( updateType === 'object' ) return node[ method ]( this );
		if ( updateType !== 'frame' && updateType !== 'render' ) return;

		const stamp = updateType + 'Id';
		const referenceMap = this[ method + 'Map' ];
		let maps = referenceMap.get( reference );
		if ( ! maps ) {

			maps = { renderId: 0, frameId: 0 };
			referenceMap.set( reference, maps );

		}
		const stampValue = this[ stamp ];
		if ( maps[ stamp ] === stampValue ) return;

		if ( suffix === 'Before' ) {

			const previous = maps[ stamp ];
			maps[ stamp ] = stampValue;
			if ( node[ method ]( this ) === false ) maps[ stamp ] = previous;

		} else if ( node[ method ]( this ) !== false ) {

			maps[ stamp ] = stampValue;

		}

	}

	updateBeforeNode( node ) {

		this.u( node, 'Before' );

	}

	updateAfterNode( node ) {

		this.u( node, 'After' );

	}

	updateNode( node ) {

		this.u( node );

	}

	update() {

		// Never increment through the public accessors: an active temporal scope
		// may expose a string frame ID and a pinned logical time. Three still owns
		// this physical RAF clock, which becomes visible again after the scope.
		this.f ++;
		const now = performance.now();
		if ( this.lastTime === undefined ) this.lastTime = now;
		this.deltaTime = ( now - this.lastTime ) / 1000;
		this.lastTime = now;
		this.t += this.deltaTime;

	}

}

export { ReplayNodeFrame };
export default ReplayNodeFrame;
