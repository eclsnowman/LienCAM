import { ui2IconSvg } from './index'
import './ui2Icon.css'

export interface Ui2IconProps {
  readonly id: string
  /** Edge in px; without it the stylesheet sizes the icon to the ribbon size token. */
  readonly size?: number
  readonly className?: string
}

/** One New UI icon. The markup comes from the generated set, never from user input. */
export function Ui2Icon({ id, size, className }: Ui2IconProps) {
  return (
    <svg
      className={className ? `ui2-icon ${className}` : 'ui2-icon'}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: ui2IconSvg(id) }}
    />
  )
}
