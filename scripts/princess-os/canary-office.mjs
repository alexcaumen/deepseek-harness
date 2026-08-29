import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const profilePackage = args.profilePackage
  ?? 'C:\\Users\\grinv\\.dsh-0.1.1-rc.2-20260822\\profiles\\web\\package.json'
const workspaceRequire = createRequire(resolve('apps/cli/package.json'))
const [cordisModule, llmModule, systemPromptModule, toolsModule] = await Promise.all([
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/cordis')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-llm')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-tools')).href),
])
const { Context } = cordisModule
const { CallId } = llmModule
const SystemPrompt = systemPromptModule.default
const Tools = toolsModule.default
const outputRoot = resolve(args.output
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\office-canary')
const receiptPath = resolve(outputRoot, 'office-canary.json')
const workbookPath = resolve(outputRoot, 'princess-os-office-canary.xlsx')
const pdfPath = resolve(outputRoot, 'princess-os-office-canary.pdf')
const presentationPath = resolve(outputRoot, 'princess-os-office-canary.pptx')
const documentPath = resolve(outputRoot, 'princess-os-office-canary.docx')

const require = createRequire(profilePackage)
const Office = require('@huiliyi37/dsh-office')
const signal = new AbortController().signal
const expectedTools = [
  'xlsx_read', 'xlsx_write', 'xlsx_edit', 'xlsx_recalc', 'xlsx_audit',
  'pdf_create', 'pdf_read', 'pdf_merge', 'pdf_split',
  'pptx_create', 'pptx_read', 'pptx_edit',
  'docx_create', 'docx_read',
].sort()

await mkdir(outputRoot, { recursive: true })
for (const path of [workbookPath, pdfPath, presentationPath, documentPath]) {
  await rm(path, { force: true })
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(Tools, {})
await ctx.plugin(Office, { enable: { xlsx: true, pdf: true, ppt: true, docx: true } })

const registeredTools = ctx.tools.schemas().map(schema => schema.name).sort()
const missingTools = expectedTools.filter(name => !registeredTools.includes(name))
const runs = []

runs.push(await execute('xlsx_write', {
    file_path: workbookPath,
    data: [['Capability', 'Status'], ['Office canary', 'PASS']],
    header_bold: true,
}))
runs.push(await execute('xlsx_read', { file_path: workbookPath, sheet: 'Sheet1' }))
runs.push(await execute('pdf_create', {
    destination_path: pdfPath,
    title: 'Princess OS Office Canary',
    content: [
      { type: 'heading', text: 'Capability parity' },
      { type: 'paragraph', text: 'Office tool execution through the Giana Code registry passed.' },
    ],
    page_numbers: true,
}))
runs.push(await execute('pdf_read', { file_path: pdfPath }))
runs.push(await execute('pptx_create', {
    destination_path: presentationPath,
    title: 'Princess OS Office Canary',
    slides: [
      { type: 'title', title: 'Princess OS Office Canary', body: 'Giana Code tool execution' },
      { type: 'content', title: 'Result', items: ['PPTX create passed', 'PPTX read passed'] },
    ],
}))
runs.push(await execute('pptx_read', { file_path: presentationPath, include: 'summary,layouts' }))
runs.push(await execute('docx_create', {
    destination_path: documentPath,
    title: 'Princess OS Office Canary',
    content: [
      { type: 'heading', text: 'Capability parity' },
      { type: 'paragraph', text: 'DOCX create and read execute through the Giana Code registry.' },
    ],
}))
runs.push(await execute('docx_read', { file_path: documentPath }))

const artifacts = [workbookPath, pdfPath, presentationPath, documentPath].map(path => ({
    path,
    exists: existsSync(path),
    bytes: existsSync(path) ? statSync(path).size : 0,
}))
const checks = {
    allFourteenToolsRegistered: missingTools.length === 0 && expectedTools.length === 14,
    createAndReadCallsPassed: runs.every(run => run.isError === false),
    allArtifactsCreated: artifacts.every(artifact => artifact.exists && artifact.bytes > 0),
    xlsxReadObserved: runs.find(run => run.name === 'xlsx_read')?.text.includes('Office canary') === true,
    pdfReadObserved: runs.find(run => run.name === 'pdf_read')?.text.includes('Capability parity') === true,
    pptxReadObserved: runs.find(run => run.name === 'pptx_read')?.text.includes('Princess OS Office Canary') === true,
    docxReadObserved: runs.find(run => run.name === 'docx_read')?.text.includes('Capability parity') === true,
}
const receipt = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    package: {
      name: '@huiliyi37/dsh-office',
      version: require('@huiliyi37/dsh-office/package.json').version,
      resolvedEntry: require.resolve('@huiliyi37/dsh-office'),
    },
    expectedToolCount: expectedTools.length,
    registeredOfficeToolCount: expectedTools.length - missingTools.length,
    expectedTools,
    missingTools,
    runs,
    artifacts,
    checks,
    pass: Object.values(checks).every(Boolean),
}
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
if (!receipt.pass) process.exitCode = 1

async function execute(name, arguments_) {
  const result = await ctx.tools.execute({
    callId: CallId(`office-canary-${name}`),
    name,
    arguments: arguments_,
    signal,
  })
  return {
    name,
    isError: result.isError === true,
    text: (result.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n'),
  }
}
