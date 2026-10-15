import { NodeUpdateType } from '../slim-replay-node-core-primitives.js';

const rendererGroups = new WeakMap();

// Match Three's render-context ownership. Only generated camera/light groups
// carry a key; material/object buffers and legacy artifacts remain independent.
export function getSharedRenderUniformGroups( renderer, renderObject ) {

	const context = renderObject?.context;
	if ( ! renderer || ! context ) return null;
	let contexts = rendererGroups.get( renderer );
	if ( ! contexts ) rendererGroups.set( renderer, contexts = new WeakMap() );
	let groups = contexts.get( context );
	if ( ! groups ) contexts.set( context, groups = new Map() );
	return groups;

}

/** Preserve explicit update scope before applying proven group ownership. */
export function resolveUniformGroupUpdateType( uniformPlan, bindingGroup, shared ) {

	const groupName = bindingGroup && bindingGroup.name || '';
	const planGroup = uniformPlan.group( groupName );
	const explicit = bindingGroup && bindingGroup.updateType != null
		? bindingGroup.updateType
		: planGroup && planGroup.updateType;
	if ( explicit != null ) return explicit;
	if ( groupName === 'object' && shared !== true ) return NodeUpdateType.OBJECT;
	if ( groupName === 'render' && shared === true ) return NodeUpdateType.RENDER;
	if ( groupName === 'frame' && shared === true ) return NodeUpdateType.FRAME;
	return null;

}
