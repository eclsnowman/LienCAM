import { HelpFigure } from './HelpFigure'
import { useText } from '../../i18n'

// These are captures of the real production modal, with numbered arrows added
// by evidence/WO-3199/capture.mjs. Keep assets inside this order's source lease.
const pictures = import.meta.glob<string>('../../help/field-guides/*.png', { eager: true, query: '?url', import: 'default' })
export function EngraveVcarveGuide({ operation }: { operation: string }) {
  const t = useText('engrave-vcarve-fields.wo3199')
  if (operation !== 'engrave' && operation !== 'vcarve') return null
  return <div data-testid="engrave-vcarve-guide">
    {Object.entries(pictures).filter(([path]) => path.includes(`/${operation}-`) || path.includes('/cut-diagram'))
      .map(([path, src]) => <HelpFigure key={path} src={src} alt={t('guidePicture', { name: path.split('/').at(-1)!.replace('.png', '').replaceAll('-', ' ') })} />)}
  </div>
}
