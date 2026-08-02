import {
	assertExactShowcaseRouteIds,
	SHOWCASE_ROUTE_IDS,
} from './route-manifest.js';

const freezeSite = ( site ) => Object.freeze( {
	...site,
	palette: Object.freeze( { ...site.palette } ),
	stats: Object.freeze( site.stats.map( stat => Object.freeze( { ...stat } ) ) ),
	ticker: Object.freeze( [ ...site.ticker ] ),
	...( site.titleLines
		? { titleLines: Object.freeze( [ ...site.titleLines ] ) }
		: {} ),
	...( site.features
		? { features: Object.freeze( site.features.map( feature => Object.freeze( { ...feature } ) ) ) }
		: {} ),
	...( site.people
		? { people: Object.freeze( site.people.map( person => Object.freeze( { ...person } ) ) ) }
		: {} ),
} );

export const SITES = Object.freeze( [
	freezeSite( {
		id: 'race',
		brand: 'APEX 24',
		title: 'Outrun the night.',
		eyebrow: 'Midnight endurance · Le Mans, 02:13',
		description: 'Carbon, courage, and 24 sleepless hours. Follow the number 08 prototype through a race measured in millimetres and remembered for decades.',
		primaryCta: 'Enter the grid',
		secondaryCta: 'Watch the race film',
		palette: {
			background: '#070707',
			primary: '#f3ff38',
			secondary: '#ff3d20',
			accent: '#f4f1e8',
		},
		stats: [
			{ value: '347', label: 'km/h on Mulsanne' },
			{ value: '24H', label: 'one relentless night' },
			{ value: '0.07', label: 'seconds between rivals' },
		],
		ticker: [ 'GRID 08', 'LAP 241', 'TYRES: SOFT', 'TRACK: 31°C', 'GAP: +0.07' ],
		sceneKind: 'race-track',
	} ),
	freezeSite( {
		id: 'tool',
		brand: 'FORM / 03',
		title: 'Shape worlds at the speed of thought.',
		eyebrow: 'A spatial tool for impossible ideas',
		description: 'Sculpt, light, animate, and ship in one fluid canvas. FORM/03 turns gestures into production-ready 3D without breaking your creative flow.',
		primaryCta: 'Start sculpting free',
		secondaryCta: 'See the 90-second demo',
		palette: {
			background: '#0b0714',
			primary: '#9d6cff',
			secondary: '#42e8d1',
			accent: '#ffcf70',
		},
		stats: [
			{ value: '12×', label: 'faster first prototype' },
			{ value: '86', label: 'live procedural tools' },
			{ value: '1', label: 'canvas from idea to export' },
		],
		ticker: [ 'NON-DESTRUCTIVE', 'REAL-TIME COLLAB', 'USDZ + GLTF', 'GPU NATIVE', 'TRY IN BROWSER' ],
		sceneKind: 'product-orbit',
	} ),
	freezeSite( {
		id: 'women',
		brand: 'CONSTELLATIONS',
		title: 'Ten lives. Infinite horizons.',
		eyebrow: 'An interactive atlas of influence',
		description: 'Meet ten women whose ideas, art, courage, and discoveries changed how humanity understands the world—and what we believe is possible.',
		primaryCta: 'Meet the ten',
		secondaryCta: 'Explore the timeline',
		palette: {
			background: '#120b1b',
			primary: '#f5b7d2',
			secondary: '#8cc8ff',
			accent: '#ffe083',
		},
		stats: [
			{ value: '10', label: 'remarkable lives' },
			{ value: '8', label: 'fields transformed' },
			{ value: '4', label: 'centuries connected' },
		],
		ticker: [ 'IMAGINE', 'DISCOVER', 'CREATE', 'LEAD', 'TEACH', 'TRANSFORM' ],
		sceneKind: 'constellation',
		people: [
			{
				name: 'Ada Lovelace',
				field: 'Computing',
				contribution: 'Envisioned a general-purpose computing machine and published its first algorithm.',
			},
			{
				name: 'Marie Curie',
				field: 'Physics & chemistry',
				contribution: 'Pioneered the study of radioactivity and won Nobel Prizes in two sciences.',
			},
			{
				name: 'Katherine Johnson',
				field: 'Spaceflight mathematics',
				contribution: 'Calculated trajectories that helped make early crewed NASA missions possible.',
			},
			{
				name: 'Frida Kahlo',
				field: 'Visual art',
				contribution: 'Expanded the language of self-portraiture through identity, pain, and resilience.',
			},
			{
				name: 'Wangari Maathai',
				field: 'Environmental leadership',
				contribution: 'Founded the Green Belt Movement, linking reforestation with dignity and democracy.',
			},
			{
				name: 'Toni Morrison',
				field: 'Literature',
				contribution: 'Reshaped the literary canon through profound stories of Black life and memory.',
			},
			{
				name: 'Tu Youyou',
				field: 'Pharmaceutical chemistry',
				contribution: 'Discovered artemisinin, a treatment that has saved millions from malaria.',
			},
			{
				name: 'Ruth Bader Ginsburg',
				field: 'Law',
				contribution: 'Built a landmark legal legacy advancing equal citizenship and gender equality.',
			},
			{
				name: 'Malala Yousafzai',
				field: 'Education advocacy',
				contribution: 'Champions every girl’s right to learn through sustained global advocacy.',
			},
			{
				name: 'Fei-Fei Li',
				field: 'Artificial intelligence',
				contribution: 'Advanced computer vision while advocating for human-centred, responsible AI.',
			},
		],
	} ),
	freezeSite( {
		id: 'robots',
		brand: 'KIN / WORKS',
		title: 'Robots with better bedside manners.',
		eyebrow: 'Adaptive robotics · Series R',
		description: 'Morrow learns the rhythm of your team, handles the repetitive work, and leaves the human decisions to humans. Precise by design. Approachable by nature.',
		primaryCta: 'Meet Morrow',
		secondaryCta: 'See it at work',
		palette: {
			background: '#081113',
			primary: '#8df5e4',
			secondary: '#ff8b5f',
			accent: '#d8e2e3',
		},
		stats: [
			{ value: '0.4mm', label: 'repeatable precision' },
			{ value: '18H', label: 'continuous operation' },
			{ value: '7 min', label: 'task changeover' },
		],
		ticker: [ 'SAFE NEAR PEOPLE', 'VISION ONLINE', 'FORCE LIMITED', 'TASK 14 COMPLETE', 'READY TO LEARN' ],
		sceneKind: 'robot-swarm',
	} ),
	freezeSite( {
		id: 'abyss',
		brand: 'HADAL / 11',
		title: 'Descend beyond daylight.',
		eyebrow: 'Expedition 06 · Challenger Deep',
		description: 'A live descent into Earth’s least-known habitat, where pressure shapes glassy bodies and every flicker of light may be a species never recorded.',
		primaryCta: 'Begin the descent',
		secondaryCta: 'Open the field log',
		palette: {
			background: '#01080f',
			primary: '#2be4ff',
			secondary: '#1456ff',
			accent: '#c7ff8b',
		},
		stats: [
			{ value: '10,935m', label: 'target depth' },
			{ value: '1,086 bar', label: 'ambient pressure' },
			{ value: '03', label: 'unknown signals' },
		],
		ticker: [ 'DEPTH 8,412M', 'O₂ NOMINAL', 'SONAR CONTACT', 'TEMP 1.2°C', 'LIGHTS 42%' ],
		sceneKind: 'deep-sea',
	} ),
	freezeSite( {
		id: 'orbit',
		brand: 'ORISON',
		title: 'Earth, from the quiet side.',
		eyebrow: 'Low orbit residency · Departures 2028',
		description: 'Six sunrises a day, a private horizon, and three nights above the weather. ORISON makes orbital travel intimate, considered, and astonishingly calm.',
		primaryCta: 'Reserve your window',
		secondaryCta: 'Tour the habitat',
		palette: {
			background: '#040713',
			primary: '#d5e5ff',
			secondary: '#5f7cff',
			accent: '#ffb36b',
		},
		stats: [
			{ value: '408km', label: 'above sea level' },
			{ value: '16', label: 'sunrises per day' },
			{ value: '90 min', label: 'around the world' },
		],
		ticker: [ 'CABIN PRESSURE STABLE', 'SUNRISE 04:12', 'ORBIT 18,442', 'WINDOW 03 CLEAR', 'EARTH BELOW' ],
		sceneKind: 'orbital-ring',
	} ),
	freezeSite( {
		id: 'pulse',
		brand: 'PULSE // CITY',
		title: 'Feel the city answer back.',
		eyebrow: 'One night · Five rooms · No repeats',
		description: 'A live electronic music ritual where architecture becomes an instrument and every crowd movement bends the light, bass, and shape of the room.',
		primaryCta: 'Get night access',
		secondaryCta: 'Hear the lineup',
		palette: {
			background: '#0d0310',
			primary: '#ff2bd6',
			secondary: '#4dffdf',
			accent: '#f5ff55',
		},
		stats: [
			{ value: '32', label: 'artists in motion' },
			{ value: '5', label: 'responsive rooms' },
			{ value: '140', label: 'BPM after midnight' },
		],
		ticker: [ 'DOORS 22:00', 'ROOM 03 LIVE', 'NO PHONES / JUST PULSE', 'BASS SYNC 98%', 'LAST TRAIN: NEVER' ],
		sceneKind: 'audio-wave',
	} ),
	freezeSite( {
		id: 'climate',
		brand: '1.5° LAB',
		title: 'Make the future visible.',
		eyebrow: 'Planetary signals · Updated now',
		description: 'Explore the systems behind a warming world, compare credible pathways, and turn global climate data into decisions your city can act on today.',
		primaryCta: 'Explore the living model',
		secondaryCta: 'See local actions',
		palette: {
			background: '#06110d',
			primary: '#7ee787',
			secondary: '#51b9ff',
			accent: '#ffd166',
		},
		stats: [
			{ value: '1.28°C', label: 'warming observed' },
			{ value: '421ppm', label: 'atmospheric CO₂' },
			{ value: '2030', label: 'decisive horizon' },
		],
		ticker: [ 'DATA: LIVE', 'GRID: 62% RENEWABLE', 'FOREST COVER +0.8%', 'HEAT ALERT', 'PATHWAY: POSSIBLE' ],
		sceneKind: 'climate-globe',
	} ),
	freezeSite( {
		id: 'fashion',
		brand: 'AER / SS27',
		title: 'Clothes for moving air.',
		eyebrow: 'Collection 07 · Cut without gravity',
		description: 'A weightless study in volume, transparency, and motion. Each piece is engineered from one continuous pattern and made only when chosen.',
		primaryCta: 'Enter the collection',
		secondaryCta: 'Watch the atelier film',
		palette: {
			background: '#f0ece4',
			primary: '#17130f',
			secondary: '#b7a4ff',
			accent: '#ff5f87',
		},
		stats: [
			{ value: '01', label: 'continuous pattern' },
			{ value: '0', label: 'unsold inventory' },
			{ value: '27g', label: 'lightest silhouette' },
		],
		ticker: [ 'LOOK 01 / VEIL', 'MADE TO ORDER', 'RECYCLED MONOFIBRE', 'PARIS 19:30', 'AIR IS THE ACCESSORY' ],
		sceneKind: 'fabric-flow',
	} ),
	freezeSite( {
		id: 'architecture',
		brand: 'MONOLITH / N',
		title: 'Build the space between people.',
		eyebrow: 'Civic works · Open competition 042',
		description: 'A public architecture studio designing generous density: cool streets, shared thresholds, adaptable rooms, and structures that improve as communities inhabit them.',
		primaryCta: 'Explore the living block',
		secondaryCta: 'Read the design brief',
		palette: {
			background: '#d9d4c8',
			primary: '#22231f',
			secondary: '#e4572e',
			accent: '#547d71',
		},
		stats: [
			{ value: '68%', label: 'shared open space' },
			{ value: '12°C', label: 'cooler courtyard peak' },
			{ value: '100Y', label: 'adaptable frame life' },
		],
		ticker: [ 'SITE 042', 'MASS TIMBER', 'NORTH LIGHT', 'COURTYARD OPEN', 'DESIGNED FOR CHANGE' ],
		sceneKind: 'parametric-city',
	} ),
] );

assertExactShowcaseRouteIds(
	SITES.map( site => site.id ),
	'Showcase site definitions',
);

export const SITE_IDS = SHOWCASE_ROUTE_IDS;
export const sites = SITES;

export const siteById = Object.freeze( Object.fromEntries(
	SITES.map( site => [ site.id, site ] ),
) );

export function isSiteId( value ) {

	return typeof value === 'string' && Object.hasOwn( siteById, value.trim().toLowerCase() );

}

export function getSite( value ) {

	if ( typeof value !== 'string' ) return null;
	return siteById[ value.trim().toLowerCase() ] || null;

}

export function getSiteFromDocument( documentRef = globalThis.document ) {

	const id = documentRef?.documentElement?.dataset?.site || documentRef?.body?.dataset?.site;
	return getSite( id );

}

export default SITES;
