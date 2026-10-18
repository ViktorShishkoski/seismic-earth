import { quat, vec3 } from 'gl-matrix';
import { latLonToCartesian } from '../geo/coords.ts';
import { orientationLooking, type CameraView } from './OrbitCamera.ts';

/**
 * Side views across the world's great subduction zones.
 *
 * Where one plate dives under another, its earthquakes trace the sinking
 * slab down to ~700 km (a "Wadati–Benioff zone"). Seen from above, those
 * quakes only differ by colour; seen edge-on — looking along the trench —
 * they line up into a dipping sheet. Each view stands beside the slab,
 * looks along the trench, and centres on the slab's middle depth.
 */
export interface SlabView {
  id: string;
  name: string;
  /** One line shown in the panel. */
  note: string;
  lat: number;
  lon: number;
  /** Depth (true scale) the camera looks at. Scaled with the depth exaggeration. */
  depthKm: number;
  /** Compass direction the camera looks: along the trench. */
  headingDeg: number;
  /** Slight downward tilt so the surface and the trench stay in frame. */
  pitchDeg: number;
  /** Distance from the camera to the look-at point, in Earth radii. */
  distance: number;
  /** Quakes farther than this from the region (km, along the surface) fade out in the view. */
  focusKm: number;
}

export const SLAB_VIEWS: readonly SlabView[] = [
  {
    id: 'japan',
    name: 'Japan',
    note: 'Pacific plate dives west under Honshu',
    lat: 38,
    lon: 140.5,
    depthKm: 220,
    headingDeg: 8, // along the Japan Trench, which runs NNE
    pitchDeg: 8,
    distance: 0.5,
    focusKm: 650, // NE Japan only: keeps the Izu–Bonin and Kuril slabs out of the line of sight
  },
  {
    id: 'tonga',
    name: 'Tonga',
    note: 'The fastest, deepest slab: quakes to 700 km',
    lat: -21,
    lon: -177.5,
    depthKm: 330,
    headingDeg: 18, // the Tonga Trench runs NNE
    pitchDeg: 6,
    distance: 0.55,
    focusKm: 1100, // the whole Tonga–Kermadec arc north of New Zealand
  },
  {
    id: 'andes',
    name: 'Andes',
    note: 'Young Nazca plate dives east at a shallow angle',
    lat: -22,
    lon: -67.5,
    depthKm: 200,
    headingDeg: 0, // the Peru–Chile Trench runs N–S here
    pitchDeg: 8,
    distance: 0.5,
    focusKm: 900,
  },
  {
    id: 'marianas',
    name: 'Marianas',
    note: 'Old, cold Pacific plate sinks almost straight down',
    lat: 18,
    lon: 145.5,
    depthKm: 250,
    headingDeg: 0, // the Mariana Trench runs roughly N–S at this latitude
    pitchDeg: 6,
    distance: 0.5,
    focusKm: 700,
  },
];

/** The camera pose for a slab view at the given depth exaggeration. */
export function slabCameraView(view: SlabView, depthScale = 1): CameraView {
  const target = vec3.fromValues(...latLonToCartesian(view.lat, view.lon, view.depthKm * depthScale));
  return {
    target,
    orientation: orientationLooking(view.lat, view.lon, view.headingDeg, view.pitchDeg, quat.create()),
    distance: view.distance * Math.max(1, Math.sqrt(depthScale)),
  };
}
