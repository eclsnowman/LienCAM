// Parameter-edit command (DOC lane, WO DOC-4, ruling 4).
//
// "All table mutations flow through the DOC-2 command layer (undo/redo
// restores table AND downstream geometry state together)." A brand-new
// parameter reuses DOC-2's existing InsertNodeCommand/RemoveNodeCommand
// unmodified (see params/table.ts) -- a parameter node is inserted/removed
// exactly like any other DagNode. Editing an EXISTING parameter's expression
// needs one command that rewires both its payload (expression/ast/value) and
// its consumes edges (which OTHER parameters it references) as a single
// atomic, undoable step; DOC-2's commands.ts has no such combined command, so
// this is the one new Command class DOC-4 owns.

import type { Command } from '../commands'
import type { FeatureDag } from '../dag'

/**
 * Rewires one parameter node's payload + consumes together. `do()` sets
 * consumes FIRST: FeatureDag.setConsumes throws DagCycleError synchronously,
 * before any mutation, if the new refs would create a cycle -- so if it
 * throws, payload is never touched and the node is left completely
 * unchanged (the caller, params/table.ts, catches this and reports a typed
 * PARAM_CYCLE diagnostic without corrupting any state; "the table stays
 * usable" per AC #2).
 */
export class SetParameterExpressionCommand implements Command {
  readonly label = 'setParameterExpression'
  private priorPayload: Record<string, unknown> | undefined
  private priorConsumes: string[] | undefined
  private readonly id: string
  private readonly nextPayload: Record<string, unknown>
  private readonly nextConsumes: string[]

  constructor(id: string, nextPayload: Record<string, unknown>, nextConsumes: string[]) {
    this.id = id
    this.nextPayload = nextPayload
    this.nextConsumes = nextConsumes
  }

  do(dag: FeatureDag): void {
    this.priorConsumes = dag.setConsumes(this.id, this.nextConsumes)
    this.priorPayload = dag.setPayload(this.id, this.nextPayload)
  }

  undo(dag: FeatureDag): void {
    if (this.priorPayload === undefined || this.priorConsumes === undefined) {
      throw new Error(`SetParameterExpressionCommand.undo: '${this.id}' was never set (do() has not run yet).`)
    }
    dag.setPayload(this.id, this.priorPayload)
    dag.setConsumes(this.id, this.priorConsumes)
  }

  serialize(): unknown {
    return { type: 'setParameterExpression', id: this.id, payload: this.nextPayload, consumes: this.nextConsumes }
  }
}
