import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';

const ThreeBundle = Object.assign({}, THREE, {
  OrbitControls,
  XRControllerModelFactory,
});

if (typeof window !== 'undefined') {
  window.THREE = ThreeBundle;
}
if (typeof globalThis !== 'undefined') {
  globalThis.THREE = ThreeBundle;
}

export default ThreeBundle;
export { OrbitControls, XRControllerModelFactory };
