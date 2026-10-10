import { describe, expect, it } from 'vitest'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { hemisphereOnSlab } from '../../cam3d/fixtures'
import { buildPartHeightField } from '../../cam3d/rough/partField'
import { modelPartSection, partSectionNeedsModelLocation } from '../../cam3d/rough/cutRegion'

describe('adaptive model sections at a vertical discontinuity', () => {
  it('resolves the rounded square corner between grid-edge crossings', async () => {
    const kernel = new BvhKernel()
    const mesh = kernel.uploadMesh(hemisphereOnSlab(12, {x:40,y:40,t:10}))
    const probe = {kind:'flat',diameter:0.1} as const
    try {
      const field = await buildPartHeightField(kernel,mesh,{originX:-5,originY:-5,nx:100,ny:100,cell:0.5},{zSeed:-1,probe})
      expect(partSectionNeedsModelLocation(field,7.5)).toBe(true)
      const rings = await modelPartSection(kernel,mesh,field,probe,7.5,0.0025)
      expect(rings).toHaveLength(1)
      const ring = rings[0]
      const errors: number[] = []
      for(let i=0;i<ring.length;i+=2) {
        const j=(i+2)%ring.length
        for(const t of [0,0.25,0.5,0.75]) {
          const x=ring[i]+t*(ring[j]-ring[i]),y=ring[i+1]+t*(ring[j+1]-ring[i+1])
          const dx=Math.max(-x,0,x-40),dy=Math.max(-y,0,y-40)
          const distance=dx||dy?Math.hypot(dx,dy):-Math.min(x,y,40-x,40-y)
          errors.push(Math.abs(distance-probe.diameter/2))
        }
      }
      expect(Math.max(...errors)).toBeLessThan(0.004)
    } finally { kernel.releaseMesh(mesh) }
  })

  it('keeps the dome rim circular at the exact slab height', async () => {
    const kernel=new BvhKernel()
    const mesh=kernel.uploadMesh(hemisphereOnSlab(12,{x:40,y:40,t:10}))
    const probe={kind:'flat',diameter:0.1} as const
    try {
      const field=await buildPartHeightField(kernel,mesh,{originX:-5,originY:-5,nx:100,ny:100,cell:0.5},{zSeed:-1,probe})
      expect(partSectionNeedsModelLocation(field,10)).toBe(true)
      const rings=await modelPartSection(kernel,mesh,field,probe,10,0.0025)
      expect(rings).toHaveLength(1)
      const radii=[]
      for(let i=0;i<rings[0].length;i+=2)radii.push(Math.hypot(rings[0][i]-20,rings[0][i+1]-20))
      // The fixture is a 64-sided mesh; its known chord error is below .015 mm.
      expect(Math.max(...radii)-Math.min(...radii)).toBeLessThan(0.025)
      expect(Math.max(...radii)).toBeCloseTo(12.05,2)
    } finally { kernel.releaseMesh(mesh) }
  })
})
