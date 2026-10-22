// The first modeling commands (WO-2993, WO-2951 "First command: model.parameter.set").
//
//   model.parameter.set  creates or edits one parameter: exactly what the
//                        Parameters table's Add / Enter does, through the same
//                        ParameterTable.prepareExpression + commit, as ONE
//                        "Agent: ..." step on the Model history.
//   model.parameters     reads every parameter (expression, value, status).
//   model.undo / .redo   the Undo / Redo button's own path (ModelSession.undo);
//                        with a Form session open, the Form's own Undo / Redo.
//
// "Parameter" is the whole family on purpose: the undo/redo/read companions of
// the first command live beside it until a second modeling command needs a file.
//
// Refusals are the screen's words: the text is formatParamDiag() of the same
// ParamDiag the Parameters table shows under its field (src/doc/params/format.ts,
// WO-2978 G3). An evaluation-time failure is NOT a refusal: `width = 1/0`
// commits, exactly as on the screen, and the result reports PARAM_DIVISION_BY_ZERO
// (LIENCAM.md rule 11 -- the software refuses only what it cannot do).

import { CompositeCommand } from '../../../doc/commands'
import { useFormStore } from '../../../form/formStore'
import { formatParamDiag } from '../../../doc/params/format'
import { textFor } from '../../../i18n'
import {
  refuse,
  type ModelEditSpec,
  type ModelHistorySpec,
  type ModelReadSpec,
} from '../registry'
import type { ParameterTable } from '../../../doc/params/table'
import type { JsonSchema } from '../schema'

const NO_ARGUMENTS: JsonSchema = { type: 'object', additionalProperties: false, properties: {} }

const STATUS_VALUES = ['ok', 'dirty', 'running', 'failed', 'degraded', 'suppressed', 'rolledBack'] as const

const PARAMETER_ROW: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'expression', 'value', 'status'],
  properties: {
    name: { type: 'string' },
    expression: { type: 'string' },
    value: { type: 'number' },
    status: { type: 'string', enum: STATUS_VALUES },
  },
}

export interface ParameterRow {
  name: string
  expression: string
  value: number
  status: string
}

export interface ParameterSetInput {
  name: string
  expression: string
}

export const parameterSetSpec: ModelEditSpec<ParameterSetInput, ParameterRow> = {
  id: 'model.parameter.set',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'expression'],
    properties: { name: { type: 'string' }, expression: { type: 'string' } },
  },
  output: PARAMETER_ROW,
  // The Parameters table has no refusal of its own beyond the expression checks
  // prepare() makes, and none is invented (ADR-0055 decision 5).
  enabled: () => null,
  prepare(session, input) {
    // The screen trims the name it is given (ParametersTable commitNew).
    const name = input.name.trim()
    const prepared = session.params.prepareExpression(name, input.expression)
    if (!prepared.ok) return refuse('refused', formatParamDiag(prepared.diag) as string)
    const existed = session.params.has(name)
    const label = textFor('sketch-and-model-workbench')('AgentCommands.setParameter', { name, expression: input.expression })
    return {
      label,
      // One history entry carrying the "Agent: ..." label, even for one command.
      commands: [new CompositeCommand([prepared.command], label)],
      touched: prepared.touched,
      changed: existed
        ? { created: [], edited: [prepared.nodeId], removed: [] }
        : { created: [prepared.nodeId], edited: [], removed: [] },
      finish: (s) => parameterRow(s.params, name),
    }
  },
}

function parameterRow(params: ParameterTable, name: string): ParameterRow {
  return {
    name,
    expression: params.expressionOf(name) ?? '',
    value: params.valueOf(name) ?? 0,
    status: params.statusOf(name),
  }
}

export const parametersReadSpec: ModelReadSpec<Record<string, never>, { parameters: ParameterRow[] }> = {
  id: 'model.parameters',
  kind: 'read',
  effect: 'read',
  input: NO_ARGUMENTS,
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['parameters'],
    properties: { parameters: { type: 'array', items: PARAMETER_ROW } },
  },
  read: (session) => ({ parameters: session.params.names().map((name) => parameterRow(session.params, name)) }),
}

// With a Form session open the page's Undo / Redo step the Form's own history
// (SolidsWorkbenchPage handleUndo / handleRedo -> useFormStore undo / redo), and so
// do these: docs/design/WO-2951-modeling-mcp.md "Undo and redo" (:287-289). This
// is the ONE store action the agent calls -- the very action the button calls;
// every other store write stays banned (registryBoundary.wo2993 test).
const FORM_STEP_LABEL = 'Form edit'

function formHistory(direction: 'undo' | 'redo'): { label: string | null } | undefined {
  const form = useFormStore.getState()
  if (!form.active) return undefined
  const pending = direction === 'undo' ? form.history.past.length : form.history.future.length
  if (direction === 'undo') form.undo()
  else form.redo()
  return { label: pending > 0 ? FORM_STEP_LABEL : null }
}

export const undoSpec: ModelHistorySpec = {
  id: 'model.undo',
  kind: 'history',
  effect: 'edit',
  direction: 'undo',
  otherHistory: () => formHistory('undo'),
  input: NO_ARGUMENTS,
  // The label of the step taken back, or null when there was nothing to undo (the design's "Undo and redo").
  output: { type: 'object', additionalProperties: false, required: ['undone'], properties: { undone: { type: ['string', 'null'] } } },
}

export const redoSpec: ModelHistorySpec = {
  id: 'model.redo',
  kind: 'history',
  effect: 'edit',
  direction: 'redo',
  otherHistory: () => formHistory('redo'),
  input: NO_ARGUMENTS,
  // The label of the step done again, or null when there was nothing to redo (the design's "Undo and redo").
  output: { type: 'object', additionalProperties: false, required: ['redone'], properties: { redone: { type: ['string', 'null'] } } },
}

