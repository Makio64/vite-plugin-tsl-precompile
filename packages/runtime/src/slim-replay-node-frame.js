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

		this.t = 0;
		this.deltaTime = 0;
		this.f = 0;
		this.renderId = 0;
		this.updateMap = new WeakMap();
		this.updateBeforeMap = new WeakMap();
		this.updateAfterMap = new WeakMap();
		this.renderer = null;
		this.material = null;
		this.camera = null;
		this.object = null;
		this.scene = null;

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

	_maps( referenceMap, nodeRef ) {

		let maps = referenceMap.get( nodeRef );
		if ( ! maps ) {

			maps = { renderId: 0, frameId: 0 };
			referenceMap.set( nodeRef, maps );

		}
		return maps;

	}

	_run( node, typeMethod, method, referenceMap, stampBefore ) {

		const updateType = node[ typeMethod ]();
		const reference = node.updateReference( this );
		if ( updateType === 'object' ) {

			return node[ method ]( this );

		}

		const stamp = updateType === 'frame' ? 'frameId' : updateType === 'render' ? 'renderId' : '';
		if ( ! stamp ) return;
		const maps = this._maps( referenceMap, reference );
		const stampValue = this[ stamp ];
		if ( maps[ stamp ] === stampValue ) return;

		if ( stampBefore ) {

			const previous = maps[ stamp ];
			maps[ stamp ] = stampValue;
			if ( node[ method ]( this ) === false ) maps[ stamp ] = previous;

		} else if ( node[ method ]( this ) !== false ) {

			maps[ stamp ] = stampValue;

		}

	}

	updateBeforeNode( node ) {

		this._run( node, 'getUpdateBeforeType', 'updateBefore', this.updateBeforeMap, true );

	}

	updateAfterNode( node ) {

		this._run( node, 'getUpdateAfterType', 'updateAfter', this.updateAfterMap, false );

	}

	updateNode( node ) {

		this._run( node, 'getUpdateType', 'update', this.updateMap, false );

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
