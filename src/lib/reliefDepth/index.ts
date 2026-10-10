// WO-2173: image relief stage 3 - photo in, detailed depth map out. The palette calls estimateReliefDepth.
export { estimateReliefDepth, disposeReliefDepth } from './client'
export { DEPTH_MODEL } from './modelStore'
export type { DepthBackend, DepthDetail, DepthImage, DepthOptions, DepthProgress, DepthResult, DepthTimings } from './types'
