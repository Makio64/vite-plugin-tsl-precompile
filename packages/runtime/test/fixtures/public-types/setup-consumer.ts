import {
	setupPrecompile,
	type DevCaptureStatus,
	type WaitForCaptureSettledOptions,
} from '@tsl-precompile/runtime/setup';
import {
	Line2NodeMaterial,
	LineBasicNodeMaterial,
	LineDashedNodeMaterial,
	MeshBasicNodeMaterial,
	MeshLambertNodeMaterial,
	MeshMatcapNodeMaterial,
	MeshNormalNodeMaterial,
	MeshPhongNodeMaterial,
	MeshPhysicalNodeMaterial,
	MeshSSSNodeMaterial,
	MeshStandardNodeMaterial,
	MeshToonNodeMaterial,
	NodeMaterial,
	PointsNodeMaterial,
	ShadowNodeMaterial,
	SpriteNodeMaterial,
	VolumeNodeMaterial,
	WebGPURenderer,
} from 'three/webgpu';

const renderer = new WebGPURenderer();
const capture = setupPrecompile( { renderer } );

capture.ready.then( () => capture.setRenderer( renderer ) );
const initialStatus: DevCaptureStatus = capture.captureStatus();
const waitOptions: WaitForCaptureSettledOptions = {
	since: initialStatus,
	timeoutMs: 1_000,
	settleMs: 0,
	allowEmpty: true,
	rejectOnFailure: true,
};
const settledStatus: Promise<DevCaptureStatus> = capture.waitForCaptureSettled( waitOptions );
void settledStatus;

const node: NodeMaterial = new NodeMaterial().precompile( 'node' );
const basic: MeshBasicNodeMaterial = new MeshBasicNodeMaterial().precompile( 'mesh-basic' );
const lambert: MeshLambertNodeMaterial = new MeshLambertNodeMaterial().precompile( 'mesh-lambert' );
const matcap: MeshMatcapNodeMaterial = new MeshMatcapNodeMaterial().precompile( 'mesh-matcap' );
const normal: MeshNormalNodeMaterial = new MeshNormalNodeMaterial().precompile( 'mesh-normal' );
const phong: MeshPhongNodeMaterial = new MeshPhongNodeMaterial().precompile( 'mesh-phong' );
const physical: MeshPhysicalNodeMaterial = new MeshPhysicalNodeMaterial().precompile( 'mesh-physical', { renderer } );
const sss: MeshSSSNodeMaterial = new MeshSSSNodeMaterial().precompile( 'mesh-sss' );
const standard: MeshStandardNodeMaterial = new MeshStandardNodeMaterial().precompile( 'mesh-standard', { renderer } );
const toon: MeshToonNodeMaterial = new MeshToonNodeMaterial().precompile( 'mesh-toon' );
const line2: Line2NodeMaterial = new Line2NodeMaterial().precompile( 'line-2' );
const lineBasic: LineBasicNodeMaterial = new LineBasicNodeMaterial().precompile( 'line-basic' );
const lineDashed: LineDashedNodeMaterial = new LineDashedNodeMaterial().precompile( 'line-dashed' );
const points: PointsNodeMaterial = new PointsNodeMaterial().precompile( 'points' );
const shadow: ShadowNodeMaterial = new ShadowNodeMaterial().precompile( 'shadow' );
const sprite: SpriteNodeMaterial = new SpriteNodeMaterial().precompile( 'sprite' );
const volume: VolumeNodeMaterial = new VolumeNodeMaterial().precompile( 'volume' );

void [
	node,
	basic,
	lambert,
	matcap,
	normal,
	phong,
	physical,
	sss,
	standard,
	toon,
	line2,
	lineBasic,
	lineDashed,
	points,
	shadow,
	sprite,
	volume,
];
