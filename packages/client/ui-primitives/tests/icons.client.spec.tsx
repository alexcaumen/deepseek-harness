// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconApiOutline14, IconArchiveOutline20, IconFolderClose16, IconGoalOutline16, IconSendOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)

describe('ic_ds_ icon set', () => {
  it('exports the full icon set including microphone and right-inspector controls', () => {
    expect(iconNames.length).toBe(72)
  })

  it.each(iconNames)('%s renders an svg with currentColor fills and no hardcoded palette', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutline16 size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('each glyph defaults to its own drawn size, not one set-wide default', () => {
    const api = render(<IconApiOutline14 />)
    expect(api.container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const folder = render(<IconFolderClose16 />)
    expect(folder.container.querySelector('svg')!.getAttribute('width')).toBe('16')
    const archive = render(<IconArchiveOutline20 />)
    expect(archive.container.querySelector('svg')!.getAttribute('width')).toBe('20')
  })

  it('renders reusable goal glyphs without document-global ids', () => {
    const { container } = render(<><IconGoalOutline16 /><IconGoalOutline16 /></>)
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('[clip-path]')).toBeNull()
  })
})

describe('FishLogo', () => {
  it('renders the Giana OS image mark at the requested square size', () => {
    const { container } = render(<primitives.FishLogo />)
    const image = container.querySelector('img')!
    expect(image.getAttribute('width')).toBe('24')
    expect(image.getAttribute('height')).toBe('24')
    expect(image.getAttribute('src')).toBe('/giana-cowork-logo.png')
  })
})

describe('BrandWordmark', () => {
  it('leaves the release label to the host surface', () => {
    vi.stubGlobal('__GIANA_DESKTOP__', { releaseVersion: '0.1.1-rc.53' })
    const view = render(<primitives.BrandWordmark />)
    expect(view.queryByText('v0.1.1-rc.53')).toBeNull()
    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(view.queryByText('v0.1.1-rc.53')).toBeNull()
  })

  it('does not display an untrusted release label', () => {
    vi.stubGlobal('__GIANA_DESKTOP__', { releaseVersion: '<script>bad</script>' })
    const view = render(<primitives.BrandWordmark />)
    expect(view.queryByText(/<script>/)).toBeNull()
  })

  it('can render the name artwork with or without its leading mark', () => {
    const view = render(<primitives.BrandWordmark />)
    expect(view.getByLabelText('Giana CoWork Preview')).toBeTruthy()
    expect(view.getByText('Preview')).toBeTruthy()
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/giana-cowork-logo.png')

    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.getByText('Preview')).toBeTruthy()
  })
})
