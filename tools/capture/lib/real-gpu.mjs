// The fail-closed real-GPU classifier. ONE copy exists, vendored at
// src/tests/support/real-gpu.mjs where the test suite pins its matcher table
// (realGpuClassifier.ui74.test.ts); this module re-exports it so harness
// scripts keep the historical tools/capture/lib import path without a second
// copy that could drift. Law: feedback_real_gpu_for_render_artifacts -
// render-artifact evidence shot on a software rasterizer proves nothing.
export { SOFTWARE_GL, HARDWARE_FAMILIES, realGpuVerdict } from '../../../src/tests/support/real-gpu.mjs'
