/**
 * Replay-owned update scheduler for hydrated node state.
 *
 * The full Three NodeFrame is a graph-runtime carrier. Slim replay only needs
 * its frame/render/object update cadence plus the live renderer context, so
 * this class preserves that lifecycle without retaining Three's node core.
 */
class ReplayNodeFrame {

	constructor() {

		this.time = 0;
		this.deltaTime = 0;
		this.frameId = 0;
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

	_getMaps( referenceMap, nodeRef ) {

		let maps = referenceMap.get( nodeRef );
		if ( maps === undefined ) {

			maps = { renderId: 0, frameId: 0 };
			referenceMap.set( nodeRef, maps );

		}
		return maps;

	}

	_runUpdate( node, typeMethod, method, referenceMap, stampBefore ) {

		const updateType = node[ typeMethod ]();
		const reference = node.updateReference( this );
		if ( updateType === 'object' ) {

			node[ method ]( this );
			return;

		}

		const stamp = updateType === 'frame' ? 'frameId' : updateType === 'render' ? 'renderId' : null;
		if ( stamp === null ) return;
		const maps = this._getMaps( referenceMap, reference );
		if ( maps[ stamp ] === this[ stamp ] ) return;

		if ( stampBefore ) {

			const previous = maps[ stamp ];
			maps[ stamp ] = this[ stamp ];
			if ( node[ method ]( this ) === false ) maps[ stamp ] = previous;

		} else if ( node[ method ]( this ) !== false ) {

			maps[ stamp ] = this[ stamp ];

		}

	}

	updateBeforeNode( node ) {

		this._runUpdate( node, 'getUpdateBeforeType', 'updateBefore', this.updateBeforeMap, true );

	}

	updateAfterNode( node ) {

		this._runUpdate( node, 'getUpdateAfterType', 'updateAfter', this.updateAfterMap, false );

	}

	updateNode( node ) {

		this._runUpdate( node, 'getUpdateType', 'update', this.updateMap, false );

	}

	update() {

		this.frameId ++;
		if ( this.lastTime === undefined ) this.lastTime = performance.now();
		this.deltaTime = ( performance.now() - this.lastTime ) / 1000;
		this.lastTime = performance.now();
		this.time += this.deltaTime;

	}

}

export { ReplayNodeFrame };
export default ReplayNodeFrame;
