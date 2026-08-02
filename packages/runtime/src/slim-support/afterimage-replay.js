/**
 * Non-rendering resource preparation for three.js's `AfterImageNode`.
 *
 * `AfterImageNode.updateBefore()` normally synchronizes its two internal
 * render targets with the input texture before drawing. Compiler-free replay
 * must establish that same descriptor state before exact texture selection,
 * but it must not invoke the effect render as part of setup.
 *
 * @module SlimSupportAfterImageReplay
 */

export const AFTERIMAGE_HISTORY_TEXTURE_NAME = 'AfterImageNode.old';
export const AFTERIMAGE_OUTPUT_TEXTURE_NAME = 'AfterImageNode.comp';

const ERROR_PREFIX = '[tsl-precompile/afterimage-replay]';

export class AfterImageReplayResourceError extends Error {

	constructor( reason, message, details = {} ) {

		super( `${ ERROR_PREFIX } ${ message }` );
		this.name = 'AfterImageReplayResourceError';
		this.code = 'TSLP_AFTERIMAGE_REPLAY_RESOURCES_UNAVAILABLE';
		this.reason = reason;
		this.details = details;
		this.tslPrecompileAfterImageReplay = true;

	}

}

/**
 * Resolve the two textures with their lifecycle semantics intact.
 *
 * After each upstream `updateBefore()` call the render-target fields swap, but
 * the texture nodes still identify the history input and just-rendered output.
 * Reading both aliases from `getTextureNode()` would therefore collapse two
 * distinct resources into one.
 *
 * @param {Object} node
 * @return {{ historyTexture: Object, outputTexture: Object }}
 */
export function getAfterImageReplayTextures( node ) {

	requireAfterImageNode( node );

	const oldRenderTarget = requireRenderTarget( node._oldRT, '_oldRT' );
	const compositeRenderTarget = requireRenderTarget( node._compRT, '_compRT' );
	const ownedTextures = new Set( [ oldRenderTarget.texture, compositeRenderTarget.texture ] );

	const historyTexture = requireTexture(
		node._textureNodeOld && node._textureNodeOld.value,
		'_textureNodeOld.value',
	);

	let outputNode = null;
	try {

		outputNode = typeof node.getTextureNode === 'function'
			? node.getTextureNode()
			: node._textureNode;

	} catch ( cause ) {

		throw resourceError(
			'output-texture-node-unavailable',
			'AfterImage output texture node could not be read.',
			{ cause },
		);

	}
	const outputTexture = requireTexture( outputNode && outputNode.value, 'getTextureNode().value' );

	if ( historyTexture === outputTexture ) {

		throw resourceError(
			'texture-aliases-collapsed',
			'AfterImage history and output aliases must resolve to distinct textures.',
		);

	}
	if ( ! ownedTextures.has( historyTexture ) || ! ownedTextures.has( outputTexture ) ) {

		throw resourceError(
			'texture-alias-not-owned',
			'AfterImage texture aliases must resolve to its two internal render targets.',
			{
				historyOwned: ownedTextures.has( historyTexture ),
				outputOwned: ownedTextures.has( outputTexture ),
			},
		);

	}

	return { historyTexture, outputTexture };

}

/**
 * Mirror the non-rendering preflight at the start of three r185's
 * `AfterImageNode.updateBefore()`:
 *
 * 1. copy the live input texture type onto both internal targets;
 * 2. size both targets to the renderer's drawing buffer.
 *
 * The function intentionally never calls `node.updateBefore()`. Invalid or
 * ambiguous state throws `AfterImageReplayResourceError` before target
 * mutation, allowing callers to fail the replay setup closed.
 *
 * @param {Object} node
 * @param {Object} renderer
 * @return {{
 *   inputTexture: Object,
 *   historyTexture: Object,
 *   outputTexture: Object,
 *   width: number,
 *   height: number,
 *   textureType: number
 * }}
 */
export function prepareAfterImageReplayResources( node, renderer ) {

	const { historyTexture, outputTexture } = getAfterImageReplayTextures( node );
	const inputTexture = requireTexture(
		node.textureNode && node.textureNode.value,
		'textureNode.value',
	);
	const textureType = inputTexture.type;
	if ( ! Number.isFinite( textureType ) ) {

		throw resourceError(
			'input-texture-type-unavailable',
			'AfterImage input texture must expose a finite numeric type.',
			{ textureType },
		);

	}
	if ( ! renderer || typeof renderer.getDrawingBufferSize !== 'function' ) {

		throw resourceError(
			'drawing-buffer-size-unavailable',
			'AfterImage replay requires renderer.getDrawingBufferSize().',
		);

	}
	if ( typeof node.setSize !== 'function' ) {

		throw resourceError(
			'set-size-unavailable',
			'AfterImage replay requires node.setSize().',
		);

	}

	const sizeTarget = createSizeTarget();
	let measuredSize = sizeTarget;
	try {

		measuredSize = renderer.getDrawingBufferSize( sizeTarget ) || sizeTarget;

	} catch ( cause ) {

		throw resourceError(
			'drawing-buffer-size-failed',
			'AfterImage drawing-buffer size could not be measured.',
			{ cause },
		);

	}

	const width = readDimension( measuredSize, sizeTarget, 'width', 'x' );
	const height = readDimension( measuredSize, sizeTarget, 'height', 'y' );
	if ( width === null || height === null ) {

		throw resourceError(
			'drawing-buffer-size-invalid',
			'AfterImage drawing-buffer dimensions must be positive finite numbers.',
			{
				width: readRawDimension( measuredSize, sizeTarget, 'width', 'x' ),
				height: readRawDimension( measuredSize, sizeTarget, 'height', 'y' ),
			},
		);

	}

	const oldRenderTarget = node._oldRT;
	const compositeRenderTarget = node._compRT;
	const previousOldType = oldRenderTarget.texture.type;
	const previousCompositeType = compositeRenderTarget.texture.type;
	try {

		compositeRenderTarget.texture.type = textureType;
		oldRenderTarget.texture.type = textureType;
		node.setSize( width, height );

	} catch ( cause ) {

		try { compositeRenderTarget.texture.type = previousCompositeType; } catch ( _ ) {}
		try { oldRenderTarget.texture.type = previousOldType; } catch ( _ ) {}
		throw resourceError(
			'resource-preflight-failed',
			'AfterImage internal render targets could not be prepared.',
			{ cause, width, height, textureType },
		);

	}

	return {
		inputTexture,
		historyTexture,
		outputTexture,
		width,
		height,
		textureType,
	};

}

function requireAfterImageNode( node ) {

	const type = effectTypeName( node );
	if ( type !== 'AfterImageNode' ) {

		throw resourceError(
			'node-type-invalid',
			'Expected an AfterImageNode.',
			{ type },
		);

	}

}

function effectTypeName( node ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return '';
	try {

		const constructorType = node.constructor && node.constructor.type;
		if ( typeof constructorType === 'string' && constructorType.length > 0 ) return constructorType;
		if ( typeof node.type === 'string' && node.type.length > 0 ) return node.type;
		const constructorName = node.constructor && node.constructor.name;
		return typeof constructorName === 'string' ? constructorName : '';

	} catch ( _ ) {

		return '';

	}

}

function requireRenderTarget( renderTarget, field ) {

	if ( ! renderTarget || renderTarget.isRenderTarget !== true ) {

		throw resourceError(
			'render-target-unavailable',
			`AfterImage ${ field } must be a live render target.`,
			{ field },
		);

	}
	requireTexture( renderTarget.texture, `${ field }.texture` );
	return renderTarget;

}

function requireTexture( texture, field ) {

	if ( ! texture || texture.isTexture !== true ) {

		throw resourceError(
			'texture-unavailable',
			`AfterImage ${ field } must be a live texture.`,
			{ field },
		);

	}
	return texture;

}

function createSizeTarget() {

	return {
		x: 0,
		y: 0,
		get width() {

			return this.x;

		},
		set width( value ) {

			this.x = value;

		},
		get height() {

			return this.y;

		},
		set height( value ) {

			this.y = value;

		},
		set( width, height ) {

			this.x = width;
			this.y = height;
			return this;

		},
		floor() {

			this.x = Math.floor( this.x );
			this.y = Math.floor( this.y );
			return this;

		},
	};

}

function readDimension( measured, fallback, primary, secondary ) {

	const value = readRawDimension( measured, fallback, primary, secondary );
	if ( ! Number.isFinite( value ) || value <= 0 ) return null;
	const integer = Math.floor( value );
	return integer > 0 ? integer : null;

}

function readRawDimension( measured, fallback, primary, secondary ) {

	for ( const source of [ measured, fallback ] ) {

		if ( ! source ) continue;
		const primaryValue = source[ primary ];
		if ( Number.isFinite( primaryValue ) && primaryValue !== 0 ) return primaryValue;
		const secondaryValue = source[ secondary ];
		if ( Number.isFinite( secondaryValue ) && secondaryValue !== 0 ) return secondaryValue;

	}
	return null;

}

function resourceError( reason, message, details = {} ) {

	return new AfterImageReplayResourceError( reason, message, details );

}
