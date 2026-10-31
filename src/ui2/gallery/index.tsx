// WO-3285 (UI M2 W1-H): the kit gallery, at ?newui=1&gallery=1. One section per kit part (the 22
// of KIT_PARTS), each showing the sample its kit lane exports. A lane adds its samples in a
// `gallery.tsx` next to its part folder and exports
//
//   export const gallery: Partial<Record<KitPart, ComponentType>> = { NumberField: () => <...> }
//
// (src/components/kit/<folder>/gallery.tsx, or src/notices/gallery.tsx for Notice). The gallery
// finds those files itself; nothing here changes when a lane adds one. A part without a sample
// says so.
import { useText } from '../../i18n'
import { KIT_PARTS } from '../../components/kit'
import { gallerySamples } from './samples'
import { LookControls } from '../shell/AppBar'
import type { ShellPrefs } from '../shell/prefs'

export function KitGallery({ prefs }: { prefs: ShellPrefs }) {
  const t = useText('ui2-shell.wo3285')
  const samples = gallerySamples()
  return (
    <div className="ui2-gallery" data-testid="ui2-gallery">
      <header className="ui2-gallery-head" data-ui2-card="appbar" data-ui2-chrome="">
        <h1 className="ui2-gallery-title">{t('galleryTitle')}</h1>
        <div className="ui2-appbar-look"><LookControls prefs={prefs} /></div>
      </header>
      <div className="ui2-gallery-body" data-ui2-card="view" data-testid="ui2-view">
        {KIT_PARTS.map(part => {
          const Sample = samples[part]
          return (
            <section key={part} className="ui2-gallery-part" data-testid={`ui2-gallery-part-${part}`} aria-label={part}>
              <h2 className="ui2-gallery-part-name">{part}</h2>
              {Sample ? <Sample /> : <p className="ui2-gallery-none">{t('galleryNoSample')}</p>}
            </section>
          )
        })}
      </div>
    </div>
  )
}
