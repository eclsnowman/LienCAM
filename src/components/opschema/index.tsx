// WO-3283 (UI M2 W1-F): the parameter-schema renderer. It draws any operation's schema with the
// kit parts, one Section per group in spec 6.4 order, and reports each edit as (key, stored
// value); the caller stores it (applyEdit in src/lib/opschema gives the operation patch). It reads
// nothing but its props and imports no CAM code, so the New Operation card and the Properties
// panel draw the same fields from the same declaration.
import type { ReactElement } from 'react'
import {
  Button, NumberField, PropRow, Section, Segmented, Select, TextField, Toggle, Tooltip,
} from '../kit'
import type { Availability } from '../../commands/types'
import { resolveMessage, type MessageKey } from '../../notices'
import {
  choicesOf, issueMessage, opSchema, rangeFor, validateFor,
  type OpContext, type OpSchema, type OpSchemaRendererProps, type ParamChoice, type ParamDecl, type ParamGroup, type ParamIssue,
  type ParamRange, type ParamRecord, type ParamValue, type ParamValues,
} from '../../lib/opschema'

const AREA = 'ui2-opschema.wo3283'
const word = (key: string, params?: Readonly<Record<string, string | number>>) => resolveMessage(`${AREA}:${key}` as MessageKey, params)
const NOT_EDITABLE: Availability = { ready: false, reason: `${AREA}:readOnly` }

/** A choice with this many options or fewer is a segmented control; more is a list (spec 6.5). */
const SEGMENTED_MAX = 3

const groupCaption = (group: ParamGroup) => word(`group.${group.startsWith('custom:') ? group.slice('custom:'.length) : group}`)

interface FieldProps {
  readonly decl: ParamDecl
  /** The key the edit and its issues are reported under ('steps.1.d' inside a list). */
  readonly path: string
  readonly value: ParamValue
  onChange(value: ParamValue): void
  readonly availability?: Availability
  readonly issues: ReadonlyMap<string, readonly ParamIssue[]>
  /** The range and choices for these values (else the declared ones). */
  readonly range?: ParamRange
  readonly choices?: readonly ParamChoice[]
}

function Field({ decl, path, value, onChange, availability, issues, range = decl.range, choices = decl.choices ?? [] }: FieldProps): ReactElement {
  const label = resolveMessage(decl.labelKey)
  const testId = `opschema-${path}`
  const own = issues.get(path) ?? []
  const withHelp = (field: ReactElement) => decl.helpKey ? <Tooltip text={resolveMessage(decl.helpKey)}>{field}</Tooltip> : field
  const shownIssues = own.map(issue => <span key={issue.reason} className="opschema-issue" role="alert">{issueMessage(issue)}</span>)
  const row = (field: ReactElement) => (
    <PropRow label={label} testId={`${testId}-row`}>
      {withHelp(field)}
      {shownIssues}
    </PropRow>
  )
  switch (decl.type) {
    case 'number':
    case 'integer':
      return row(
        <NumberField
          ariaLabel={label} testId={testId} availability={availability}
          value={typeof value === 'number' ? value : null}
          quantity={decl.quantity ?? (decl.type === 'integer' ? 'count' : 'none')}
          min={range?.min} max={range?.max} step={decl.step} precision={decl.precision}
          optional={decl.default === null}
          onChange={onChange}
        />,
      )
    case 'boolean':
      return (
        <>
          {withHelp(<Toggle ariaLabel={label} label={label} testId={testId} availability={availability} on={value === true} onChange={onChange} />)}
          {shownIssues}
        </>
      )
    case 'choice': {
      const options = choices.map(c => ({ value: c.value, label: resolveMessage(c.labelKey) }))
      const current = typeof value === 'string' ? value : ''
      const props = { ariaLabel: label, testId, availability, value: current, options, onChange: (v: string) => onChange(v) }
      return row(options.length <= SEGMENTED_MAX ? <Segmented {...props} /> : <Select {...props} />)
    }
    case 'text':
      return row(<TextField ariaLabel={label} testId={testId} availability={availability} value={typeof value === 'string' ? value : ''} onChange={onChange} />)
    case 'list':
      return <ListField decl={decl} path={path} value={value} onChange={onChange} availability={availability} issues={issues} />
    case 'tool':
    case 'geometry':
      // drawn by the screen's own picker; the slot marks where it goes
      return row(<span data-opschema-slot={path} />)
  }
}

function ListField({ decl, path, value, onChange, availability, issues }: FieldProps): ReactElement {
  const items = Array.isArray(value) ? value as readonly ParamRecord[] : []
  const fields = decl.item ?? []
  const label = resolveMessage(decl.labelKey)
  const setItem = (index: number, next: ParamRecord) => onChange(items.map((item, i) => (i === index ? next : item)))
  const fresh = (): ParamRecord => Object.fromEntries(fields.map(f => [f.key, structuredClone(f.default)]))
  return (
    <div className="opschema-list" data-testid={`opschema-${path}`}>
      {items.map((item, index) => (
        <div key={index} role="group" aria-label={word('list.item', { label, index: index + 1 })} className="opschema-list-item">
          {opSchema.visibleParams({ opType: decl.key, params: fields }, item).map(f => (
            <Field
              key={f.key} decl={f} path={`${path}.${index}.${f.key}`} value={item[f.key]} availability={availability} issues={issues}
              onChange={v => setItem(index, { ...item, [f.key]: v })}
            />
          ))}
          <Button
            kind="momentary" form="text" emphasis="ghost" availability={availability}
            label={word('list.remove', { label, index: index + 1 })}
            onPress={() => onChange(items.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button kind="momentary" form="small" availability={availability} label={word('list.add', { label })} onPress={() => onChange([...items, fresh()])} />
    </div>
  )
}

export interface OpSchemaFormProps extends OpSchemaRendererProps {
  /** The operation's tool, for the ranges that depend on it (contract gap: not in the renderer
   *  props yet, so it is an optional extra here). */
  readonly context?: OpContext
}

function fieldsOf(schema: OpSchema, params: readonly ParamDecl[], values: ParamValues, context: OpContext,
  availability: Availability | undefined, issues: ReadonlyMap<string, readonly ParamIssue[]>, onChange: OpSchemaRendererProps['onChange']) {
  return params.map(p => (
    <Field
      key={p.key} decl={p} path={p.key} value={values[p.key]} availability={availability} issues={issues}
      range={rangeFor(schema, p, context)} choices={choicesOf(schema, p, values)}
      onChange={v => onChange(p.key, v)}
    />
  ))
}

/** The operation card body: every visible parameter of the schema, grouped and ordered. A group
 *  of rarely changed fields starts folded; in a mixed group they sit in a folded Advanced section
 *  (spec 6.4), as the old dialog's Advanced disclosure holds them. */
export function OpSchemaForm({ schema, values, onChange, readOnly, context = {} }: OpSchemaFormProps): ReactElement {
  const issues = new Map<string, ParamIssue[]>()
  for (const issue of validateFor(schema, values, context)) issues.set(issue.key, [...(issues.get(issue.key) ?? []), issue])
  const availability = readOnly ? NOT_EDITABLE : undefined
  return (
    <div className="opschema-form" data-testid={`opschema-${schema.opType}`}>
      {opSchema.groupsOf(schema, values).map(({ group, params }) => {
        const core = params.filter(p => !p.advanced)
        const advanced = params.filter(p => p.advanced)
        // an issue in a folded field opens its section, so the reason is never hidden
        const flagged = advanced.some(p => [...issues.keys()].some(k => k === p.key || k.startsWith(`${p.key}.`)))
        return (
          <Section key={group} caption={groupCaption(group)} defaultOpen={core.length > 0 || flagged} testId={`opschema-group-${group}`}>
            {fieldsOf(schema, core.length > 0 ? core : advanced, values, context, availability, issues, onChange)}
            {core.length > 0 && advanced.length > 0 && (
              <Section caption={word('group.advanced')} defaultOpen={flagged} testId={`opschema-advanced-${group}`}>
                {fieldsOf(schema, advanced, values, context, availability, issues, onChange)}
              </Section>
            )}
          </Section>
        )
      })}
    </div>
  )
}
