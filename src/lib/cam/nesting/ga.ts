/* Seeded genetic algorithm for the nesting engine.
 *
 * PORTED from the vendored SVGnest GeneticAlgorithm
 * (vendored/svgnest-svgnest.reference.js.txt, GeneticAlgorithm + the adam
 * seeding in launchWorkers). The gene is (part ORDER, per-part ROTATION index).
 *
 * DETERMINISM is the #1 port risk (NESTING-P1-ENGINE-PLAN.md): SVGnest calls
 * Math.random in FIVE places, every one of which is rerouted here to a single
 * seeded mulberry32 generator threaded in as `rng`. The former Math.random
 * sites, all now `rng()`:
 *   1. launchWorkers `shuffle` (unused for seeding here - the seed ordering is
 *      the DETERMINISTIC area-descending sort per the plan, not a shuffle).
 *   2. randomAngle's Fisher-Yates `shuffleArray`  (Math.floor(rng()*(i+1))).
 *   3. mutate: the order-swap probability test and the rotation-reroll test.
 *   4. mate: the single-point crossover `cutpoint`.
 *   5. randomWeightedIndividual: the front-weighted selection draw.
 * No Date / Set-iteration-order / object-key-order nondeterminism is introduced.
 * Identical (genes, rng seed, sheet) => byte-identical population across runs.
 */

import type { Vec2 } from '../../../types/index'
import { getPolygonBounds, polygonArea, rotatePolygon } from './geometry'

/** A source part as the GA sees it: stable id, geometry, and its allowed
 *  rotation angles (degrees). A locked part has exactly one allowed angle. */
export interface GaPart {
  partId: string
  instanceId: string
  outer: Vec2[]
  /** Allowed insertion angles in degrees (e.g. [0,90,180,270] or locked [a]). */
  allowedAngles: number[]
  /** The real outline (same frame as `outer`) and the clearance it keeps from
   *  the sheet edge. When given, randomAngle's sheet-fit test measures this,
   *  not the proxy, so it agrees with placement.ts sheetFit: the proxy may reach
   *  past the real outline to space parts apart, and that extra must not rule
   *  out an angle at which the part fits (WO-2480 audit). */
  sheetFit?: { outer: Vec2[]; pad: number }
}

/** One GA individual: an insertion order (genes) and a chosen angle per gene.
 *  `fitness` is undefined until the placement worker evaluates it. */
export interface Individual {
  placement: GaPart[]
  rotation: number[]
  fitness?: number
}

export interface GaConfig {
  populationSize: number
  /** Percent (0-100): per-gene probability of an order swap / rotation reroll. */
  mutationRate: number
}

/**
 * Seeded GA over part order + rotation. Mirrors SVGnest's GeneticAlgorithm but
 * with every random draw routed through `rng` (a mulberry32 instance) and the
 * angle set supplied per part (so orientation lock = a single allowed angle).
 */
export class GeneticAlgorithm {
  population: Individual[]
  private config: GaConfig
  private binBounds: { width: number; height: number }
  private rng: () => number

  constructor(adam: GaPart[], sheet: { width: number; height: number }, config: GaConfig, rng: () => number) {
    this.config = config
    this.binBounds = sheet
    this.rng = rng

    // seed ordering: parts sorted by |area| DESCENDING (deterministic, plan).
    // (SVGnest sorts adam this way too; the launchWorkers shuffle is not used.)
    const seeded = adam.slice(0).sort((a, b) => Math.abs(polygonArea(b.outer)) - Math.abs(polygonArea(a.outer)))

    const angles: number[] = []
    for (let i = 0; i < seeded.length; i++) {
      angles.push(this.randomAngle(seeded[i]))
    }

    this.population = [{ placement: seeded, rotation: angles }]
    while (this.population.length < config.populationSize) {
      this.population.push(this.mutate(this.population[0]))
    }
  }

  /** Pick an allowed insertion angle, preferring one whose rotated part still
   *  fits the sheet bounds. Fisher-Yates shuffle uses the seeded rng. A locked
   *  part has a single allowed angle, so it is always returned unchanged. */
  randomAngle(part: GaPart): number {
    const angleList = part.allowedAngles.slice(0)

    // Fisher-Yates (seeded) - was Math.random in SVGnest shuffleArray
    for (let i = angleList.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      const tmp = angleList[i]
      angleList[i] = angleList[j]
      angleList[j] = tmp
    }

    for (let i = 0; i < angleList.length; i++) {
      const fit = part.sheetFit
      const rotated = rotatePolygon(fit ? fit.outer : part.outer, angleList[i])
      const b = getPolygonBounds(rotated)
      const pad = fit ? 2 * fit.pad : 0
      if (b.width + pad < this.binBounds.width && b.height + pad < this.binBounds.height) {
        return angleList[i]
      }
    }
    // fall back to the first allowed angle (never silently 0 for a locked part)
    return angleList.length > 0 ? part.allowedAngles[0] : 0
  }

  /** Return a mutated clone: per gene, maybe swap with the next, maybe reroll
   *  the rotation. Both probability draws use the seeded rng. */
  mutate(individual: Individual): Individual {
    const clone: Individual = {
      placement: individual.placement.slice(0),
      rotation: individual.rotation.slice(0),
    }
    for (let i = 0; i < clone.placement.length; i++) {
      if (this.rng() < 0.01 * this.config.mutationRate) {
        const j = i + 1
        if (j < clone.placement.length) {
          const tmp = clone.placement[i]
          clone.placement[i] = clone.placement[j]
          clone.placement[j] = tmp
        }
      }
      if (this.rng() < 0.01 * this.config.mutationRate) {
        clone.rotation[i] = this.randomAngle(clone.placement[i])
      }
    }
    return clone
  }

  /** Single-point order crossover (seeded cutpoint). Produces two children whose
   *  gene order interleaves the parents' while keeping each instance exactly once. */
  mate(male: Individual, female: Individual): [Individual, Individual] {
    const cutpoint = Math.round(
      Math.min(Math.max(this.rng(), 0.1), 0.9) * (male.placement.length - 1)
    )

    const gene1 = male.placement.slice(0, cutpoint)
    const rot1 = male.rotation.slice(0, cutpoint)
    const gene2 = female.placement.slice(0, cutpoint)
    const rot2 = female.rotation.slice(0, cutpoint)

    const has = (gene: GaPart[], id: string): boolean => gene.some((g) => g.instanceId === id)

    for (let i = 0; i < female.placement.length; i++) {
      if (!has(gene1, female.placement[i].instanceId)) {
        gene1.push(female.placement[i])
        rot1.push(female.rotation[i])
      }
    }
    for (let i = 0; i < male.placement.length; i++) {
      if (!has(gene2, male.placement[i].instanceId)) {
        gene2.push(male.placement[i])
        rot2.push(male.rotation[i])
      }
    }

    return [
      { placement: gene1, rotation: rot1 },
      { placement: gene2, rotation: rot2 },
    ]
  }

  /** Advance one generation: elitism keeps the fittest, then weighted-random
   *  mating fills the rest, each child slightly mutated. */
  generation(): void {
    // lower fitness is better; undefined fitness sorts last
    this.population.sort((a, b) => (a.fitness ?? Infinity) - (b.fitness ?? Infinity))

    const newpopulation: Individual[] = [this.population[0]]
    while (newpopulation.length < this.population.length) {
      const male = this.randomWeightedIndividual()
      const female = this.randomWeightedIndividual(male)
      const children = this.mate(male, female)
      newpopulation.push(this.mutate(children[0]))
      if (newpopulation.length < this.population.length) {
        newpopulation.push(this.mutate(children[1]))
      }
    }
    this.population = newpopulation
  }

  /** Front-weighted random pick (fitter individuals are nearer the front after
   *  generation()'s sort). Seeded draw. */
  randomWeightedIndividual(exclude?: Individual): Individual {
    const pop = this.population.slice(0)
    if (exclude) {
      const idx = pop.indexOf(exclude)
      if (idx >= 0) pop.splice(idx, 1)
    }

    const rand = this.rng()
    let lower = 0
    const weight = 1 / pop.length
    let upper = weight

    for (let i = 0; i < pop.length; i++) {
      if (rand > lower && rand < upper) {
        return pop[i]
      }
      lower = upper
      upper += 2 * weight * ((pop.length - i) / pop.length)
    }
    return pop[0]
  }
}
