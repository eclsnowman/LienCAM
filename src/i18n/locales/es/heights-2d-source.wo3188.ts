// WO-3188: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const heights2dSource: Translation<'heights-2d-source.wo3188'> = {
  chamferAssumed: 'Este contorno no tiene altura propia: el chaflán empieza en la parte superior del material en este punto. Elija aquí Parte superior del material en bruto, Parte inferior del material en bruto o un desfase para situarlo.',
  geometryAssumed: 'Este contorno no tiene altura propia: Geometría es el plano en el que está, Z {{z}} {{unit}}. Elija aquí Parte superior del material en bruto, Parte inferior del material en bruto o un desfase para situar el corte.',
}

export default heights2dSource
