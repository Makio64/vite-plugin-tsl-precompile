export const CASES = [
	{ id: 'knot', name: 'The baseline', category: 'Simple material', description: 'One lit torus knot. A reference point for the heavier scenes.', variants: [ 'default' ] },
	{ id: 'studio', name: 'Reflection studio', category: 'PMREM · environment lighting', description: 'A room-generated PMREM atlas lights a gallery of metal and clearcoat sculptures.', variants: [ 'default' ] },
	{ id: 'lava', name: 'Lava forge', category: 'Custom animated shaders', description: 'Layered procedural noise, vertex displacement and emissive lava. Three compiled shader topologies.', variants: [ 'molten', 'crust', 'plasma' ] },
	{ id: 'bloom', name: 'Neon reactor', category: 'Post-processing', description: 'A mechanical reactor with emissive rings, animated lights and a multi-pass bloom pipeline.', variants: [ 'default' ] },
	{ id: 'game', name: 'Outpost racer', category: 'Game scene · many objects', description: 'An animated racer flies through a dense outpost of buildings, gates and track markers.', variants: [ 'default' ] },
	{ id: 'product', name: 'Material configurator', category: 'Real glTF asset · PBR · variants', description: 'A textured Shopify shoe in a studio environment. Fabric, coated and iridescent material variants.', variants: [ 'fabric', 'coated', 'iridescent' ] },
];
export const VIEWPORT = { width: 960, height: 640 };
