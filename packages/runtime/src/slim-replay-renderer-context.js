/**
 * Graph-free replacement for Renderer.contextNode in precompiled replay.
 *
 * RenderObject only needs stable context identity/version for pipeline cache
 * invalidation. Shader construction is already captured in the artifact, so
 * retaining Three's ContextNode and high-precision ModelNode graphs here is
 * both unnecessary and misleading.
 */

// Three Node ids are non-negative. Keep replay-owned ids in a disjoint range
// so temporarily swapping an XR/pass ContextNode cannot accidentally reuse the
// same RenderObject dynamic cache key.
let nextContextId = - 1;
const highPrecisionRenderers = new WeakSet();

class ReplayRendererContext {

	constructor( value = {}, parent = null ) {

		this.isReplayRendererContext = true;
		this.isNode = true;
		this.isContextNode = true;
		this.id = nextContextId --;
		this.version = 0;
		this.parent = parent;
		this.value = value && typeof value === 'object' ? value : {};

	}

	set needsUpdate( value ) {

		if ( value === true ) this.version ++;

	}

	context( value = {} ) {

		return new ReplayRendererContext( value, this );

	}

	getFlowContextData() {

		const inherited = this.parent && typeof this.parent.getFlowContextData === 'function'
			? this.parent.getFlowContextData()
			: {};
		// Three traverses the outer ContextNode first and its wrapped node
		// afterward, so wrapped/root values win duplicate keys.
		return { ...this.value, ...inherited };

	}

}

export function createReplayRendererContext( value = {} ) {

	return new ReplayRendererContext( value );

}

function ensureReplayRendererContext( renderer ) {

	if ( ! renderer || ( typeof renderer !== 'object' && typeof renderer !== 'function' ) ) {

		throw new TypeError( 'Replay renderer context requires a renderer object.' );

	}
	const current = renderer.contextNode;
	if ( current && current.isReplayRendererContext === true ) return current;
	let value = current && current.value;
	if ( current && typeof current.getFlowContextData === 'function' ) {

		const flowData = current.getFlowContextData();
		if ( flowData && typeof flowData === 'object' ) value = flowData;

	}
	const context = createReplayRendererContext( value );
	renderer.contextNode = context;
	return context;

}

export function setReplayRendererHighPrecision( renderer, value ) {

	if ( ! renderer || ( typeof renderer !== 'object' && typeof renderer !== 'function' ) ) {

		throw new TypeError( 'Replay renderer context requires a renderer object.' );

	}
	const enabled = value === true;
	const previous = highPrecisionRenderers.has( renderer );
	if ( enabled === previous ) return;
	const context = ensureReplayRendererContext( renderer );
	if ( enabled ) highPrecisionRenderers.add( renderer );
	else highPrecisionRenderers.delete( renderer );
	context.needsUpdate = true;

}

export function getReplayRendererHighPrecision( renderer ) {

	return !! renderer && highPrecisionRenderers.has( renderer );

}
