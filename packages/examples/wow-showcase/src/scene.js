import {
	BoxGeometry,
	Color,
	ConeGeometry,
	CylinderGeometry,
	DirectionalLight,
	DodecahedronGeometry,
	Group,
	HemisphereLight,
	IcosahedronGeometry,
	Mesh,
	MeshStandardNodeMaterial,
	OctahedronGeometry,
	PerspectiveCamera,
	Scene,
	SphereGeometry,
	TorusGeometry,
	TorusKnotGeometry,
	Vector3,
} from 'three/webgpu';
import {
	color as tslColor,
	cos,
	float,
	mix,
	positionLocal,
	sin,
} from 'three/tsl';

import { markShowcaseMaterials } from './markers.js';

const DEFAULT_PALETTE = Object.freeze( {
	background: '#070b12',
	primary: '#dcecff',
	secondary: '#59b8ff',
	accent: '#ffcc66',
} );

const MATERIAL_PROFILES = Object.freeze( {
	'race-track': [ 5.8, 0.42, 0.16, 0.72, 0.18 ],
	'product-orbit': [ 3.4, 0.28, 0.22, 0.56, 0.28 ],
	constellation: [ 4.2, 0.24, 0.34, 0.68, 0.22 ],
	'robot-swarm': [ 6.1, 0.36, 0.48, 0.46, 0.18 ],
	'deep-sea': [ 2.7, 0.2, 0.12, 0.74, 0.36 ],
	'orbital-ring': [ 4.8, 0.18, 0.42, 0.62, 0.2 ],
	'audio-wave': [ 8.2, 0.72, 0.32, 0.38, 0.44 ],
	'climate-globe': [ 3.7, 0.16, 0.08, 0.78, 0.2 ],
	'fabric-flow': [ 5.2, 0.3, 0.04, 0.82, 0.16 ],
	'parametric-city': [ 7.4, 0.22, 0.54, 0.5, 0.14 ],
} );

function normalizedPalette( palette = {} ) {

	return {
		background: palette.background || DEFAULT_PALETTE.background,
		primary: palette.primary || DEFAULT_PALETTE.primary,
		secondary: palette.secondary || DEFAULT_PALETTE.secondary,
		accent: palette.accent || DEFAULT_PALETTE.accent,
	};

}

function createShowcaseMaterials( palette, sceneKind ) {

	const [ scale, speed, metalness, roughness, glow ] = MATERIAL_PROFILES[ sceneKind ] || MATERIAL_PROFILES[ 'product-orbit' ];
	const p = positionLocal.mul( scale );
	const surfaceBand = sin(
		p.x
			.add( p.y.mul( 0.63 ) )
			.add( cos( p.z.mul( 0.71 + speed * 0.08 ) ) ),
	).add(
		cos( p.z.mul( 0.82 ).sub( p.x.mul( 0.31 ) ) ),
	).mul( 0.25 ).add( 0.5 );

	const accentBand = cos(
		p.y.mul( 1.37 )
			.sub( p.z.mul( 0.44 ) )
			.add( sin( p.x.mul( 0.58 + speed * 0.04 ) ) ),
	).mul( 0.5 ).add( 0.5 );

	const surface = new MeshStandardNodeMaterial( {
		metalness,
		roughness,
	} );
	surface.colorNode = mix( tslColor( palette.primary ), tslColor( palette.secondary ), surfaceBand );
	surface.roughnessNode = mix( float( Math.max( 0.12, roughness - 0.22 ) ), float( Math.min( 0.92, roughness + 0.14 ) ), surfaceBand );
	surface.emissiveNode = mix( tslColor( palette.background ), tslColor( palette.secondary ), surfaceBand ).mul( glow );

	const accent = new MeshStandardNodeMaterial( {
		metalness: Math.min( 0.82, metalness + 0.2 ),
		roughness: Math.max( 0.16, roughness - 0.24 ),
	} );
	accent.colorNode = mix( tslColor( palette.secondary ), tslColor( palette.accent ), accentBand );
	accent.roughnessNode = mix( float( 0.14 ), float( 0.42 ), accentBand );
	accent.emissiveNode = mix( tslColor( palette.secondary ), tslColor( palette.accent ), accentBand ).mul( glow + 0.24 );

	return { surface, accent };

}

function createGeometryStore() {

	const geometries = new Set();
	return {
		make( Geometry, ...args ) {

			const geometry = new Geometry( ...args );
			geometries.add( geometry );
			return geometry;

		},
		dispose() {

			for ( const geometry of geometries ) geometry.dispose();
			geometries.clear();

		},
	};

}

function addMesh( parent, geometry, material, {
	position = null,
	rotation = null,
	scale = null,
} = {} ) {

	const object = new Mesh( geometry, material );
	if ( position ) object.position.set( ...position );
	if ( rotation ) object.rotation.set( ...rotation );
	if ( scale ) object.scale.set( ...scale );
	parent.add( object );
	return object;

}

function setCamera( camera, position, target = [ 0, 0, 0 ], fov = 44 ) {

	camera.fov = fov;
	camera.position.set( ...position );
	camera.lookAt( ...target );
	camera.updateProjectionMatrix();

}

function buildRaceTrack( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 5.7, 9.4 ], [ 0, 0, 0 ], 42 );

	const ringGeometry = geometry.make( TorusGeometry, 3.45, 0.18, 16, 128 );
	const stripeGeometry = geometry.make( BoxGeometry, 0.08, 0.035, 0.48 );
	const chassisGeometry = geometry.make( BoxGeometry, 0.72, 0.2, 1.16 );
	const canopyGeometry = geometry.make( BoxGeometry, 0.42, 0.18, 0.48 );

	const track = addMesh( world, ringGeometry, materials.surface, {
		rotation: [ Math.PI / 2, 0, 0 ],
		scale: [ 1, 0.58, 1 ],
	} );
	addMesh( world, ringGeometry, materials.accent, {
		rotation: [ Math.PI / 2, 0, 0 ],
		scale: [ 0.82, 0.44, 0.82 ],
	} );

	for ( let index = 0; index < 32; index ++ ) {

		const angle = index / 32 * Math.PI * 2;
		const stripe = addMesh( world, stripeGeometry, materials.accent, {
			position: [ Math.cos( angle ) * 3.45, 0.08, Math.sin( angle ) * 2 ],
			rotation: [ 0, - angle, 0 ],
		} );
		stripe.scale.z = index % 2 === 0 ? 1 : 0.45;

	}

	const racers = [];
	for ( let index = 0; index < 4; index ++ ) {

		const racer = new Group();
		const phase = index / 4 * Math.PI * 2;
		addMesh( racer, chassisGeometry, materials.surface );
		addMesh( racer, canopyGeometry, materials.accent, { position: [ 0, 0.18, - 0.08 ] } );
		world.add( racer );
		racers.push( { racer, phase, speed: 0.34 + index * 0.025 } );

	}

	return ( elapsed ) => {

		track.rotation.z = elapsed * 0.025;
		for ( const { racer, phase, speed } of racers ) {

			const angle = phase + elapsed * speed;
			const x = Math.cos( angle ) * 3.45;
			const z = Math.sin( angle ) * 2;
			racer.position.set( x, 0.28 + Math.sin( elapsed * 5 + phase ) * 0.035, z );
			racer.rotation.y = Math.atan2( - Math.sin( angle ) * 3.45, Math.cos( angle ) * 2 );

		}

	};

}

function buildProductOrbit( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 0.7, 7.5 ], [ 0, 0.15, 0 ], 39 );

	const hero = addMesh(
		world,
		geometry.make( TorusKnotGeometry, 1.18, 0.34, 160, 24, 2, 5 ),
		materials.surface,
	);
	const pedestal = addMesh(
		world,
		geometry.make( CylinderGeometry, 1.25, 1.55, 0.26, 64 ),
		materials.surface,
		{ position: [ 0, - 1.75, 0 ] },
	);
	const ringGeometry = geometry.make( TorusGeometry, 2.25, 0.025, 10, 128 );
	const nodeGeometry = geometry.make( IcosahedronGeometry, 0.12, 1 );
	const rings = [
		addMesh( world, ringGeometry, materials.accent, { rotation: [ 0.4, 0.1, 0.1 ] } ),
		addMesh( world, ringGeometry, materials.accent, { rotation: [ 1.1, 0.55, 0.3 ], scale: [ 0.82, 0.82, 0.82 ] } ),
		addMesh( world, ringGeometry, materials.accent, { rotation: [ 0.7, - 0.9, 0.8 ], scale: [ 1.14, 1.14, 1.14 ] } ),
	];
	const nodes = [];

	for ( let index = 0; index < 10; index ++ ) {

		const angle = index / 10 * Math.PI * 2;
		nodes.push( addMesh( world, nodeGeometry, index % 2 ? materials.surface : materials.accent, {
			position: [ Math.cos( angle ) * 2.55, Math.sin( angle * 2 ) * 0.48, Math.sin( angle ) * 2.55 ],
		} ) );

	}

	return ( elapsed ) => {

		hero.rotation.set( elapsed * 0.18, elapsed * 0.32, elapsed * 0.08 );
		pedestal.rotation.y = - elapsed * 0.12;
		rings.forEach( ( ring, index ) => {

			ring.rotation.z = index * 0.34 + Math.sin( elapsed * 0.45 + index ) * 0.16;

		} );
		nodes.forEach( ( node, index ) => {

			const angle = index / nodes.length * Math.PI * 2 + elapsed * ( 0.1 + index % 3 * 0.018 );
			node.position.x = Math.cos( angle ) * 2.55;
			node.position.z = Math.sin( angle ) * 2.55;
			node.rotation.y = elapsed + index;

		} );

	};

}

function buildConstellation( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 2.3, 10.2 ], [ 0, 0.5, 0 ], 42 );

	const stemGeometry = geometry.make( CylinderGeometry, 0.13, 0.22, 1.25, 12 );
	const starGeometry = geometry.make( DodecahedronGeometry, 0.38, 0 );
	const haloGeometry = geometry.make( TorusGeometry, 0.58, 0.025, 8, 48 );
	const monuments = [];

	for ( let index = 0; index < 10; index ++ ) {

		const angle = index / 10 * Math.PI * 2;
		const radius = 2.4 + ( index % 2 ) * 0.7;
		const monument = new Group();
		const height = 0.78 + index % 4 * 0.16;
		addMesh( monument, stemGeometry, materials.surface, {
			position: [ 0, - 0.75, 0 ],
			scale: [ 1, height, 1 ],
		} );
		const star = addMesh( monument, starGeometry, materials.accent );
		const halo = addMesh( monument, haloGeometry, materials.accent, { rotation: [ Math.PI / 2, 0, 0 ] } );
		const baseY = Math.sin( angle * 3 ) * 0.55;
		monument.position.set( Math.cos( angle ) * radius, baseY, Math.sin( angle ) * radius * 0.48 );
		world.add( monument );
		monuments.push( { monument, star, halo, phase: angle, baseY } );

	}

	const core = addMesh( world, geometry.make( IcosahedronGeometry, 0.72, 2 ), materials.surface );

	return ( elapsed ) => {

		core.rotation.set( elapsed * 0.12, elapsed * 0.2, 0 );
		for ( const { monument, star, halo, phase, baseY } of monuments ) {

			monument.position.y = baseY + Math.sin( elapsed * 0.65 + phase ) * 0.18;
			star.rotation.y = elapsed * 0.28 + phase;
			halo.rotation.z = elapsed * 0.12 - phase;

		}

		world.rotation.y = Math.sin( elapsed * 0.12 ) * 0.18;

	};

}

function buildRobotSwarm( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 2.1, 9.2 ], [ 0, 0.35, 0 ], 42 );

	const bodyGeometry = geometry.make( BoxGeometry, 0.82, 0.9, 0.58 );
	const headGeometry = geometry.make( BoxGeometry, 0.68, 0.46, 0.58 );
	const jointGeometry = geometry.make( SphereGeometry, 0.13, 16, 10 );
	const limbGeometry = geometry.make( CylinderGeometry, 0.08, 0.1, 0.72, 10 );
	const eyeGeometry = geometry.make( SphereGeometry, 0.075, 12, 8 );
	const robots = [];

	for ( let index = 0; index < 7; index ++ ) {

		const robot = new Group();
		addMesh( robot, bodyGeometry, materials.surface );
		addMesh( robot, headGeometry, materials.surface, { position: [ 0, 0.73, 0 ] } );
		addMesh( robot, eyeGeometry, materials.accent, { position: [ - 0.16, 0.77, 0.3 ] } );
		addMesh( robot, eyeGeometry, materials.accent, { position: [ 0.16, 0.77, 0.3 ] } );
		const leftArm = addMesh( robot, limbGeometry, materials.accent, {
			position: [ - 0.58, 0, 0 ],
			rotation: [ 0, 0, - 0.18 ],
		} );
		const rightArm = addMesh( robot, limbGeometry, materials.accent, {
			position: [ 0.58, 0, 0 ],
			rotation: [ 0, 0, 0.18 ],
		} );
		addMesh( robot, jointGeometry, materials.accent, { position: [ - 0.48, - 0.48, 0 ] } );
		addMesh( robot, jointGeometry, materials.accent, { position: [ 0.48, - 0.48, 0 ] } );
		const row = Math.floor( index / 4 );
		const baseY = row * 1.15 - 0.65;
		robot.position.set( ( index % 4 - 1.5 ) * 1.85, baseY, - row * 1.5 );
		robot.scale.setScalar( row ? 0.78 : 1 );
		world.add( robot );
		robots.push( { robot, leftArm, rightArm, phase: index * 0.8, baseY } );

	}

	return ( elapsed ) => {

		for ( const { robot, leftArm, rightArm, phase, baseY } of robots ) {

			robot.position.y = baseY + Math.sin( elapsed * 1.5 + phase ) * 0.075;
			robot.rotation.y = Math.sin( elapsed * 0.55 + phase ) * 0.12;
			leftArm.rotation.x = Math.sin( elapsed * 1.2 + phase ) * 0.38;
			rightArm.rotation.x = - leftArm.rotation.x;

		}

	};

}

function buildDeepSea( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 0.4, 9 ], [ 0, - 0.2, 0 ], 44 );

	const creature = new Group();
	const bell = addMesh( creature, geometry.make( SphereGeometry, 1.35, 48, 24 ), materials.surface, {
		scale: [ 1, 0.62, 1 ],
	} );
	addMesh( creature, geometry.make( TorusGeometry, 1.12, 0.08, 12, 64 ), materials.accent, {
		position: [ 0, - 0.28, 0 ],
		rotation: [ Math.PI / 2, 0, 0 ],
	} );
	const tentacleGeometry = geometry.make( CylinderGeometry, 0.025, 0.07, 2.7, 10 );
	const tentacles = [];
	for ( let index = 0; index < 12; index ++ ) {

		const angle = index / 12 * Math.PI * 2;
		const tentacle = addMesh( creature, tentacleGeometry, index % 3 ? materials.surface : materials.accent, {
			position: [ Math.cos( angle ) * 0.72, - 1.55, Math.sin( angle ) * 0.72 ],
			rotation: [ Math.sin( angle ) * 0.12, 0, Math.cos( angle ) * 0.12 ],
		} );
		tentacles.push( { tentacle, angle } );

	}
	world.add( creature );

	const bubbleGeometry = geometry.make( SphereGeometry, 0.08, 12, 8 );
	const rockGeometry = geometry.make( IcosahedronGeometry, 0.42, 1 );
	const bubbles = [];
	for ( let index = 0; index < 28; index ++ ) {

		const bubble = addMesh( world, bubbleGeometry, materials.accent, {
			position: [ ( ( index * 37 ) % 19 - 9 ) * 0.38, - 3 + ( index % 9 ) * 0.7, - 1.5 + ( index % 6 ) * 0.55 ],
			scale: [ 0.45 + index % 3 * 0.2, 0.45 + index % 3 * 0.2, 0.45 + index % 3 * 0.2 ],
		} );
		bubbles.push( { bubble, base: bubble.position.y, phase: index * 0.7 } );

	}
	for ( let index = 0; index < 12; index ++ ) {

		addMesh( world, rockGeometry, materials.surface, {
			position: [ ( index - 5.5 ) * 0.7, - 3.05 + index % 2 * 0.16, - 1.4 + index % 4 * 0.75 ],
			scale: [ 0.6 + index % 3 * 0.25, 0.35 + index % 2 * 0.22, 0.8 ],
			rotation: [ index * 0.17, index * 0.4, 0 ],
		} );

	}

	return ( elapsed ) => {

		creature.position.y = Math.sin( elapsed * 0.55 ) * 0.34;
		creature.rotation.y = elapsed * 0.08;
		bell.scale.y = 0.62 + Math.sin( elapsed * 1.25 ) * 0.055;
		tentacles.forEach( ( { tentacle, angle } ) => {

			tentacle.rotation.z = Math.cos( angle ) * 0.12 + Math.sin( elapsed * 0.8 + angle ) * 0.12;

		} );
		bubbles.forEach( ( { bubble, base, phase } ) => {

			bubble.position.y = base + ( elapsed * ( 0.2 + phase % 3 * 0.03 ) + phase ) % 5.8;

		} );

	};

}

function buildOrbitalRing( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 1.1, 8.8 ], [ 0, 0, 0 ], 40 );

	const globe = addMesh( world, geometry.make( SphereGeometry, 1.65, 64, 32 ), materials.surface, {
		rotation: [ 0.18, 0, - 0.12 ],
	} );
	const ringGeometry = geometry.make( TorusGeometry, 2.45, 0.045, 12, 128 );
	const rings = [
		addMesh( world, ringGeometry, materials.accent, { rotation: [ Math.PI / 2.8, 0, 0.2 ] } ),
		addMesh( world, ringGeometry, materials.accent, { rotation: [ Math.PI / 1.7, 0.2, - 0.45 ], scale: [ 1.18, 1.18, 1.18 ] } ),
		addMesh( world, ringGeometry, materials.surface, { rotation: [ 0.35, 0.9, 0.1 ], scale: [ 0.82, 0.82, 0.82 ] } ),
	];
	const capsuleGeometry = geometry.make( BoxGeometry, 0.16, 0.16, 0.48 );
	const satellites = [];

	for ( let index = 0; index < 18; index ++ ) {

		const satellite = addMesh( world, capsuleGeometry, index % 4 ? materials.accent : materials.surface );
		satellites.push( { satellite, phase: index / 18 * Math.PI * 2, radius: 2.45 + index % 3 * 0.28 } );

	}

	return ( elapsed ) => {

		globe.rotation.y = elapsed * 0.09;
		rings.forEach( ( ring, index ) => { ring.rotation.z = elapsed * ( index % 2 ? - 0.075 : 0.055 ) + index; } );
		satellites.forEach( ( { satellite, phase, radius }, index ) => {

			const angle = phase + elapsed * ( 0.13 + index % 3 * 0.012 );
			satellite.position.set( Math.cos( angle ) * radius, Math.sin( angle * 2 + index ) * 0.56, Math.sin( angle ) * radius );
			satellite.lookAt( 0, 0, 0 );

		} );

	};

}

function buildAudioWave( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 2.1, 10 ], [ 0, 0.3, 0 ], 43 );

	const barGeometry = geometry.make( BoxGeometry, 0.13, 1, 0.28 );
	const bars = [];
	for ( let index = 0; index < 49; index ++ ) {

		const x = ( index - 24 ) * 0.17;
		const bar = addMesh( world, barGeometry, index % 5 === 0 ? materials.accent : materials.surface, {
			position: [ x, 0, Math.sin( index * 0.55 ) * 0.75 ],
		} );
		bars.push( { bar, phase: index * 0.37, envelope: 1 - Math.abs( index - 24 ) / 32 } );

	}
	const portal = addMesh( world, geometry.make( TorusGeometry, 2.45, 0.12, 16, 96 ), materials.accent, {
		position: [ 0, 0.4, - 1.15 ],
	} );
	const core = addMesh( world, geometry.make( OctahedronGeometry, 0.72, 1 ), materials.surface, {
		position: [ 0, 0.45, - 0.9 ],
	} );

	return ( elapsed ) => {

		for ( const { bar, phase, envelope } of bars ) {

			const height = 0.16 + Math.abs( Math.sin( elapsed * 3.4 + phase ) ) * ( 0.8 + envelope * 1.9 );
			bar.scale.y = height;
			bar.position.y = height * 0.5 - 0.8;
			bar.rotation.z = Math.sin( elapsed * 0.8 + phase ) * 0.05;

		}
		portal.rotation.z = elapsed * 0.16;
		core.rotation.set( elapsed * 0.34, - elapsed * 0.42, elapsed * 0.16 );

	};

}

function buildClimateGlobe( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 0.8, 8.4 ], [ 0, 0, 0 ], 40 );

	const globeGroup = new Group();
	const globe = addMesh( globeGroup, geometry.make( SphereGeometry, 1.82, 64, 32 ), materials.surface );
	const ringGeometry = geometry.make( TorusGeometry, 1.87, 0.018, 8, 96 );
	for ( let index = - 2; index <= 2; index ++ ) {

		const latitude = addMesh( globeGroup, ringGeometry, materials.accent, {
			rotation: [ Math.PI / 2, 0, 0 ],
			position: [ 0, index * 0.5, 0 ],
			scale: [ Math.sqrt( 1 - Math.min( 0.9, index * index * 0.075 ) ), Math.sqrt( 1 - Math.min( 0.9, index * index * 0.075 ) ), 1 ],
		} );
		latitude.scale.multiplyScalar( 0.94 );

	}
	for ( let index = 0; index < 4; index ++ ) {

		addMesh( globeGroup, ringGeometry, materials.accent, { rotation: [ 0, index * Math.PI / 4, 0 ] } );

	}

	const markerGeometry = geometry.make( ConeGeometry, 0.08, 0.34, 12 );
	const up = new Vector3( 0, 1, 0 );
	for ( let index = 0; index < 22; index ++ ) {

		const y = 1 - ( index + 0.5 ) / 22 * 2;
		const radius = Math.sqrt( 1 - y * y );
		const angle = index * 2.399963;
		const direction = new Vector3( Math.cos( angle ) * radius, y, Math.sin( angle ) * radius );
		const marker = addMesh( globeGroup, markerGeometry, index % 3 ? materials.accent : materials.surface, {
			position: direction.clone().multiplyScalar( 2.02 ).toArray(),
		} );
		marker.quaternion.setFromUnitVectors( up, direction );

	}
	world.add( globeGroup );

	const orbit = addMesh( world, geometry.make( TorusGeometry, 2.75, 0.045, 10, 128 ), materials.accent, {
		rotation: [ 0.7, 0.2, 0.35 ],
	} );

	return ( elapsed ) => {

		globe.rotation.y = elapsed * 0.035;
		globeGroup.rotation.y = elapsed * 0.08;
		globeGroup.rotation.z = Math.sin( elapsed * 0.18 ) * 0.08;
		orbit.rotation.z = elapsed * 0.09;

	};

}

function buildFabricFlow( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 0, 0.8, 9.5 ], [ 0, 0.15, 0 ], 38 );

	const ribbonGeometry = geometry.make( BoxGeometry, 0.22, 3.8, 0.055 );
	const beadGeometry = geometry.make( SphereGeometry, 0.11, 14, 10 );
	const ribbons = [];
	for ( let index = 0; index < 26; index ++ ) {

		const phase = index / 25 * Math.PI * 2;
		const ribbon = addMesh( world, ribbonGeometry, index % 4 === 0 ? materials.accent : materials.surface, {
			position: [ ( index - 12.5 ) * 0.23, Math.sin( phase ) * 0.38, Math.cos( phase ) * 0.55 ],
			rotation: [ Math.sin( phase ) * 0.22, 0, Math.sin( phase * 2 ) * 0.12 ],
		} );
		ribbons.push( { ribbon, phase } );

	}
	const beads = [];
	for ( let index = 0; index < 18; index ++ ) {

		const phase = index / 18 * Math.PI * 2;
		const bead = addMesh( world, beadGeometry, materials.accent, {
			position: [ Math.cos( phase ) * 2.6, Math.sin( phase * 2 ) * 1.55, Math.sin( phase ) * 0.8 ],
		} );
		beads.push( { bead, phase } );

	}
	const collar = addMesh( world, geometry.make( TorusGeometry, 1.1, 0.08, 12, 64 ), materials.accent, {
		position: [ 0, 2, 0 ],
		rotation: [ Math.PI / 2, 0, 0 ],
	} );

	return ( elapsed ) => {

		ribbons.forEach( ( { ribbon, phase }, index ) => {

			ribbon.position.y = Math.sin( elapsed * 0.72 + phase ) * 0.42;
			ribbon.position.z = Math.cos( elapsed * 0.48 + phase ) * 0.58;
			ribbon.rotation.z = Math.sin( elapsed * 0.6 + phase * 1.4 ) * 0.19;
			ribbon.rotation.y = Math.sin( elapsed * 0.35 + index * 0.12 ) * 0.16;

		} );
		beads.forEach( ( { bead, phase } ) => {

			bead.position.y = Math.sin( elapsed * 0.55 + phase * 2 ) * 1.55;

		} );
		collar.rotation.z = elapsed * 0.12;

	};

}

function buildParametricCity( context ) {

	const { world, camera, geometry, materials } = context;
	setCamera( camera, [ 7.4, 6.4, 9.2 ], [ 0, 0.8, 0 ], 39 );

	const buildingGeometry = geometry.make( BoxGeometry, 0.72, 1, 0.72 );
	const crownGeometry = geometry.make( BoxGeometry, 0.78, 0.055, 0.78 );
	const buildings = [];
	for ( let x = - 3; x <= 3; x ++ ) {

		for ( let z = - 3; z <= 3; z ++ ) {

			if ( Math.abs( x ) <= 1 && Math.abs( z ) <= 1 ) continue;
			const height = 0.8 + ( Math.sin( x * 1.7 + z * 0.8 ) * 0.5 + 0.5 ) * 2.7;
			const material = ( x + z ) % 4 === 0 ? materials.accent : materials.surface;
			const building = addMesh( world, buildingGeometry, material, {
				position: [ x * 0.92, height * 0.5 - 1.05, z * 0.92 ],
				scale: [ 1, height, 1 ],
			} );
			addMesh( world, crownGeometry, materials.accent, {
				position: [ x * 0.92, height - 1.02, z * 0.92 ],
			} );
			buildings.push( { building, baseHeight: height, phase: x * 0.6 + z * 0.9 } );

		}

	}
	const plaza = addMesh( world, geometry.make( CylinderGeometry, 1.3, 1.55, 0.16, 6 ), materials.accent, {
		position: [ 0, - 1.05, 0 ],
	} );
	const beacon = addMesh( world, geometry.make( OctahedronGeometry, 0.42, 1 ), materials.surface, {
		position: [ 0, 0.35, 0 ],
	} );

	return ( elapsed ) => {

		world.rotation.y = Math.sin( elapsed * 0.12 ) * 0.16;
		buildings.forEach( ( { building, baseHeight, phase } ) => {

			const pulse = 1 + Math.sin( elapsed * 0.45 + phase ) * 0.025;
			building.scale.y = baseHeight * pulse;

		} );
		plaza.rotation.y = elapsed * 0.08;
		beacon.position.y = 0.35 + Math.sin( elapsed * 0.8 ) * 0.18;
		beacon.rotation.y = elapsed * 0.3;

	};

}

const BUILDERS = Object.freeze( {
	'race-track': buildRaceTrack,
	'product-orbit': buildProductOrbit,
	constellation: buildConstellation,
	'robot-swarm': buildRobotSwarm,
	'deep-sea': buildDeepSea,
	'orbital-ring': buildOrbitalRing,
	'audio-wave': buildAudioWave,
	'climate-globe': buildClimateGlobe,
	'fabric-flow': buildFabricFlow,
	'parametric-city': buildParametricCity,
} );

function pointerAxis( pointer, key, index ) {

	const value = pointer?.[ key ] ?? pointer?.[ index ] ?? 0;
	return Number.isFinite( value ) ? Math.max( - 1, Math.min( 1, value ) ) : 0;

}

/**
 * Create one route's complete scene without drawing it. The caller owns the
 * renderer and performs the first real render after this function returns.
 */
export function createShowcaseScene( { renderer, site } ) {

	if ( ! renderer ) throw new TypeError( '[wow-showcase] renderer is required.' );
	if ( ! site?.id || ! site?.sceneKind ) throw new TypeError( '[wow-showcase] site.id and site.sceneKind are required.' );

	const build = BUILDERS[ site.sceneKind ];
	if ( ! build ) throw new Error( `[wow-showcase] Unknown scene kind "${ site.sceneKind }".` );

	const palette = normalizedPalette( site.palette );
	const scene = new Scene();
	scene.background = new Color( palette.background );

	const camera = new PerspectiveCamera( 44, 1, 0.1, 100 );
	const presentation = new Group();
	const world = new Group();
	presentation.add( world );
	scene.add( presentation );

	scene.add( new HemisphereLight( palette.primary, palette.background, 1.65 ) );
	const keyLight = new DirectionalLight( palette.accent, 3.4 );
	keyLight.position.set( 4.5, 6, 5 );
	scene.add( keyLight );
	const rimLight = new DirectionalLight( palette.secondary, 2.1 );
	rimLight.position.set( - 5, 2, - 4 );
	scene.add( rimLight );

	const geometry = createGeometryStore();
	const materials = createShowcaseMaterials( palette, site.sceneKind );
	const animate = build( {
		renderer,
		scene,
		camera,
		presentation,
		world,
		geometry,
		materials,
		palette,
	} );

	// Both graphs and every material flag are final here. The first real draw is
	// owned by main.js, so the live marker can observe the complete scene.
	markShowcaseMaterials( site.id, materials );

	let disposed = false;
	return {
		scene,
		camera,
		tick( elapsed = 0, pointer = null ) {

			if ( disposed ) return;
			const seconds = Number.isFinite( elapsed ) ? elapsed : 0;
			const pointerX = pointerAxis( pointer, 'x', 0 );
			const pointerY = pointerAxis( pointer, 'y', 1 );
			presentation.rotation.y += ( pointerX * 0.16 - presentation.rotation.y ) * 0.045;
			presentation.rotation.x += ( - pointerY * 0.1 - presentation.rotation.x ) * 0.045;
			animate?.( seconds, pointer );

		},
		resize( width, height ) {

			if ( disposed ) return;
			const safeWidth = Math.max( 1, Number( width ) || 1 );
			const safeHeight = Math.max( 1, Number( height ) || 1 );
			camera.aspect = safeWidth / safeHeight;
			camera.updateProjectionMatrix();

		},
		dispose() {

			if ( disposed ) return;
			disposed = true;
			geometry.dispose();
			materials.surface.dispose();
			materials.accent.dispose();
			scene.clear();

		},
	};

}
