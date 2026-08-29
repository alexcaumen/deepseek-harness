import { describe, expect, it } from 'vitest'
import {
  capabilityTitle,
  inferCapabilityCategory,
  loaderStatus,
  type CapabilityCategory,
} from '../src/client/inventoryPresentation.ts'

describe('capability inventory presentation', () => {
  it.each<[string, string, CapabilityCategory]>([
    ['@fixture/slack-connector', 'slack', 'connectors-productivity'],
    ['@fixture/figma-code-connect', 'figma', 'developer-design'],
    ['@fixture/data-analytics', 'analytics', 'data-analytics'],
    ['@fixture/openfoam-engineering', 'engineering', 'engineering'],
    ['@fixture/finance-crm', 'finance', 'finance-business'],
    ['@fixture/creative-image-media', 'media', 'creative-media'],
    ['@fixture/tool-web-search', 'web', 'browser-automation'],
    ['@fixture/extension', 'windows-desktop-automation', 'windows-desktop-automation'],
    ['@fixture/office-documents', 'office', 'documents-office'],
    ['@fixture/voice-dictation', 'voice', 'voice-dictation'],
    ['@fixture/llm-compute', 'models', 'models-compute'],
    ['@fixture/security-governance', 'security', 'security-governance'],
    ['@deepseek-ai/dsh-client-hmr', 'hmr', 'system-internals'],
    ['@fixture/unclassified-extension', 'unknown', 'system-internals'],
  ])('categorizes %s deterministically as %s', (moduleName, entryId, expected) => {
    expect(inferCapabilityCategory(moduleName, entryId)).toBe(expected)
  })

  it.each([
    [{ enabled: true, fiberPhase: 'active' as const }, 'mounted'],
    [{ enabled: true, fiberPhase: null }, 'enabled-unmounted'],
    [{ enabled: true, fiberPhase: 'pending' as const }, 'pending'],
    [{ enabled: true, fiberPhase: 'loading' as const }, 'loading'],
    [{ enabled: true, fiberPhase: 'unloading' as const }, 'unloading'],
    [{ enabled: true, fiberPhase: 'failed' as const }, 'mount-failed'],
    [{ enabled: false, fiberPhase: 'active' as const }, 'disabled'],
  ])('maps %# to the literal %s Loader status', (entry, expected) => {
    expect(loaderStatus(entry)).toBe(expected)
  })

  it('creates a readable title without discarding the technical source value', () => {
    expect(capabilityTitle('@deepseek-ai/dsh-tool-web-search-deepseek')).toBe('Web Search DeepSeek')
    expect(capabilityTitle('@fixture/figma-code-connect')).toBe('Figma Code Connect')
  })
})
