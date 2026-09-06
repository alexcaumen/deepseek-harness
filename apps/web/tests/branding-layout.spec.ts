/// <reference types="vite/client" />
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import sidebarClasses from '../../../packages/client/ui-sidebar/src/client/SidebarRoot.module.css'
import heroClasses from '../../../packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css'

interface MarkPresentation {
  size: number
  className?: string | undefined
}

type RenderBrandSlot = (key: string, owner: unknown, options?: { fallback?: ReactNode }) => ReactNode

interface HeroPresentation {
  renderSlot: RenderBrandSlot
  t: (key: string) => string
}

interface SidebarPresentation extends HeroPresentation {
  width: number
  collapsed: boolean
  startSession: () => void
  toggleSidebar: () => void
  useSessions: () => never
  useWorkspaces: () => never
}

// Package projects check the components' full types. This source-loader boundary
// keeps the browser fixture from importing service declaration merges into tests.
async function sourceComponent<Props>(relative: string, exportName: string): Promise<ComponentType<Props>> {
  const url = new URL(relative, import.meta.url).href
  const module: unknown = await import(/* @vite-ignore */ url)
  if (module === null || typeof module !== 'object') throw new Error(`Invalid source module: ${relative}`)
  const component = (module as Record<string, unknown>)[exportName]
  if (typeof component !== 'function') throw new Error(`Missing source component: ${exportName}`)
  return component as ComponentType<Props>
}

function markPresentation(owner: unknown): MarkPresentation {
  if (owner === null || typeof owner !== 'object' || !('size' in owner) || typeof owner.size !== 'number') {
    throw new Error('Brand slot must supply its requested numeric size')
  }
  const className = 'className' in owner ? owner.className : undefined
  if (className !== undefined && typeof className !== 'string') throw new Error('Brand className must be a string')
  return { size: owner.size, className }
}

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const logo = readFileSync(new URL('../public/giana-cowork-logo.png', import.meta.url))
function cssModule(relative: string, classes: Record<string, string>) {
  const source = read(relative)
  // Vitest's CSS-module proxy is not serializable; materialize only referenced names.
  const names = Array.from(source.matchAll(/\.([a-zA-Z_][\w-]*)/g), match => match[1]!)
  return { source, classes: Object.fromEntries(names.map(name => [name, classes[name]])) }
}
const sheets = [
  { source: read('../../../packages/client/ui-theme/src/styles/design-platform.css'), classes: {} },
  cssModule('../../../packages/client/ui-sidebar/src/client/SidebarRoot.module.css', sidebarClasses),
  cssModule('../../../packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css', heroClasses),
]

async function createMarkup() {
  const SidebarRoot = await sourceComponent<SidebarPresentation>('../../../packages/client/ui-sidebar/src/client/SidebarRoot.tsx', 'SidebarRoot')
  const HeroShell = await sourceComponent<HeroPresentation>('../../../packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx', 'HeroShell')
  const OfficialBrandMark = await sourceComponent<MarkPresentation>('../../../packages/client/ui-brand-official/src/client/Brand.tsx', 'OfficialBrandMark')
  const OfficialBrandName = await sourceComponent<Record<string, never>>('../../../packages/client/ui-brand-official/src/client/Brand.tsx', 'OfficialBrandName')
  return (sidebarWidth: number, official: boolean) => {
    const renderSlot: RenderBrandSlot = (key, owner, options) => {
      if (official && key === 'sidebar.brand.name') return createElement(OfficialBrandName)
      if (official && key === 'sidebar.brand.mark') {
        return createElement(OfficialBrandMark, markPresentation(owner))
      }
      return options?.fallback ?? null
    }
    const heroSlot: RenderBrandSlot = (key, owner, options) => {
      if (official && key === 'conversation.hero.brand.mark') {
        return createElement(OfficialBrandMark, markPresentation(owner))
      }
      return options?.fallback ?? null
    }
    const sidebar = createElement(SidebarRoot, {
      width: sidebarWidth, collapsed: sidebarWidth === 56,
      startSession() {}, toggleSidebar() {}, renderSlot,
      useSessions() { throw new Error('branding must not read sessions') },
      useWorkspaces() { throw new Error('branding must not read workspaces') },
      t: key => key,
    })
    const hero = createElement(HeroShell, {
      renderSlot: heroSlot,
      t: key => key === 'hero.headline' ? 'Giana CoWork' : key === 'hero.preview' ? 'Preview' : key,
    })
    return `<aside>${renderToStaticMarkup(sidebar)}</aside><main>${renderToStaticMarkup(hero)}</main>`
  }
}

// Opt in to browser QA without making ordinary source tests require Chromium.
describe.skipIf(process.env.GCP_BRAND_VISUAL_QA !== '1')('GCP source branding layout', () => {
  it('fits expanded and rail branding at desktop and mobile widths with the current image', async () => {
    const markup = await createMarkup()
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await page.route('http://gcp-brand.test/**', async (route) => {
        if (route.request().url().endsWith('/giana-cowork-logo.png')) {
          await route.fulfill({ contentType: 'image/png', body: logo })
        } else {
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Giana CoWork Preview</title>' })
        }
      })
      await page.goto('http://gcp-brand.test/')
      for (const sample of [
        { width: 1280, height: 800, sidebar: 300, official: true, label: 'desktop-slotted' },
        { width: 800, height: 600, sidebar: 260, official: false, label: 'narrow-fallback' },
        { width: 390, height: 844, sidebar: 56, official: true, label: 'mobile-rail' },
      ]) {
        await page.setViewportSize(sample)
        await page.setContent(`<!doctype html><title>Giana CoWork Preview</title><body>${markup(sample.sidebar, sample.official)}</body>`)
        await page.addStyleTag({ content: `
          * { box-sizing: border-box; }
          body { margin: 0; font-family: "Segoe UI", sans-serif; display: grid;
            grid-template-columns: ${sample.sidebar}px minmax(0, 1fr); min-height: 100vh; }
          aside, main { min-width: 0; }
          main { display: flex; align-items: center; justify-content: center; padding: 16px; }
        ` })
        await page.evaluate((sources) => {
          const parsed = sources.map(({ source, classes }) => {
            const sheet = new CSSStyleSheet()
            sheet.replaceSync(source)
            const scope = (rules: CSSRuleList) => {
              for (const rule of rules) {
                if (rule instanceof CSSStyleRule) {
                  rule.selectorText = rule.selectorText.replace(/\.([a-zA-Z_][\w-]*)/g,
                    (selector, name: string) => classes[name] ? `.${classes[name]}` : selector)
                }
                if (rule instanceof CSSGroupingRule) scope(rule.cssRules)
              }
            }
            scope(sheet.cssRules)
            return sheet
          })
          document.adoptedStyleSheets = parsed
        }, sheets)
        await page.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())))
        expect(await page.title()).toBe('Giana CoWork Preview')
        expect(await page.locator('main').innerText()).toContain('Preview')
        expect(await page.locator('main > div').ariaSnapshot()).toBe('- text: Giana CoWork Preview')
        const headline = await page.locator(`.${heroClasses.headlineText}`).boundingBox()
        expect(headline?.width).toBeGreaterThan(150)
        expect(headline?.height).toBeLessThanOrEqual(64)
        const hero = await page.locator('main img').boundingBox()
        const sidebar = await page.locator('aside img').boundingBox()
        expect([hero?.width, hero?.height]).toEqual([96, 96])
        expect([sidebar?.width, sidebar?.height]).toEqual(sample.sidebar === 56 ? [32, 32] : [64, 64])
        expect(await page.evaluate(() => {
          const clipped: string[] = []
          for (const element of document.querySelectorAll('main span, aside img, aside [aria-label="Giana CoWork Preview"]')) {
            const box = element.getBoundingClientRect()
            const host = element.closest('main, aside')!.getBoundingClientRect()
            if (box.width && (box.left < host.left || box.right > host.right + 1 || box.top < host.top || box.bottom > host.bottom + 1)) {
              clipped.push(element.textContent || element.tagName)
            }
          }
          return clipped
        })).toEqual([])
        if (sample.sidebar === 56) {
          await page.locator(`.${sidebarClasses.toggle}`).hover()
          expect(await page.locator('aside img').isVisible()).toBe(false)
          expect(await page.locator(`.${sidebarClasses.toggle} svg`).isVisible()).toBe(true)
          await page.mouse.move(sample.width - 1, sample.height - 1)
          expect(await page.locator('aside img').isVisible()).toBe(true)
        }
        const screenshotDir = process.env.GCP_BRAND_SCREENSHOT_DIR
        if (screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true })
          await page.screenshot({ path: join(screenshotDir, `${sample.label}.png`) })
        }
      }
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 30_000)
})
