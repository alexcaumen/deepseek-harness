/** Human-facing capability catalog. Loader entries never define this list. */

export const PUBLIC_FEATURE_CATEGORIES = [
  'communication-collaboration',
  'productivity-office',
  'engineering-industrial',
  'data-science-analytics',
  'finance',
  'business-operations',
  'developer-automation',
  'creative-media',
  'research-knowledge',
  'infrastructure-ai-compute',
  'models-providers',
  'security-governance',
] as const

export type PublicFeatureCategory = typeof PUBLIC_FEATURE_CATEGORIES[number]

export type PublicFeatureState =
  | 'DISCOVERABLE'
  | 'INSTALLED'
  | 'REGISTERED'
  | 'ENABLED'
  | 'NEEDS_SIGN_IN'
  | 'NEEDS_RUNTIME'
  | 'READY'
  | 'DEGRADED'
  | 'FAILED'
  | 'HELD'

export interface PublicFeature {
  readonly id: number
  readonly title: string
  readonly category: PublicFeatureCategory
  /** Declared/source state; this is not a live runtime receipt. */
  readonly state: PublicFeatureState
  /** Live state is populated only by an attached runtime evidence source. */
  readonly runtimeState: PublicFeatureState
  readonly detail: string
}

const TITLES: Readonly<Record<PublicFeatureCategory, readonly string[]>> = {
  'communication-collaboration': [
    'Lark Conversations and App Delivery', 'Email and Inbox Workflows',
    'Calendar and Scheduling', 'Meetings, Transcripts, and Action Registers',
    'Team Messaging and Channels', 'Contacts, People, and Organization Directory',
    'Notifications, Reminders, and Completion Alerts',
    'Shared Comments, Mentions, Approvals, and Handoffs',
  ],
  'productivity-office': [
    'Document Authoring and Review', 'Spreadsheet Analysis and Editing',
    'Presentation Authoring and Playback', 'PDF Read, Extract, Compare, and Annotate',
    'Universal File and Artifact Viewer', 'OCR, MarkItDown, and Structured Extraction',
    'Visual Annotation, Redline, and Side Chat', 'Indonesian Dictation and Speech Playback',
  ],
  'engineering-industrial': [
    'CAD, BIM, and 3D Engineering Files', 'P&ID, Process Flow, and Engineering Drawings',
    'Electrical, Instrumentation, Loop, and I/O Engineering',
    'Process Modeling, Simulation, and Optimization', 'CFD, Meshing, and Flow Analysis',
    'Civil, Structural, and Liquid-Retaining Design',
    'Geospatial, Site, and Industrial Visual Intelligence',
    'Construction, Commissioning, Reliability, and Maintenance',
  ],
  'data-science-analytics': [
    'Jupyter and Reproducible Notebook Workflows', 'SQL, Database, and Data-Warehouse Workflows',
    'Data Profiling, Quality, Cleaning, and Validation',
    'Charts, Dashboards, and Interactive Visualization',
    'KPI, Metric Diagnostics, and Management Reporting',
    'Forecasting, Scenario, Sensitivity, and Monte Carlo',
    'Time Series, Historian, Anomaly, and Root-Cause Analysis',
    'RAG, Embeddings, Semantic Search, and Knowledge Graphs',
  ],
  finance: [
    'FP&A, Accounting, and Financial Control', 'Budgeting, Planning, and Variance Analysis',
    'Valuation and Corporate Financial Modeling', 'Integrated Three-Statement Modeling',
    'Financial Scenarios, Stress Tests, and Breakeven Analysis',
    'Capital Markets, Equity, Credit, and Event Analysis',
    'Invoice, Billing, Payment, and Reconciliation Workflows',
    'Deal, Proposal, Commercial, and Investment Analysis',
  ],
  'business-operations': [
    'ERP Master Data and Workflow Governance', 'CRM, Leads, Accounts, Sales, and Customer Lifecycle',
    'Project, Task, Goal, Todo, and Operating Cadence',
    'Procurement, Supply Chain, Vendor, and Logistics',
    'HR, Payroll, Benefits, and Workforce Operations', 'Legal, Contract, Claim, and Document Control',
    'HSE, QMS, Permit, Incident, and Corrective Action',
    'Marketing, E-commerce, Content, and Growth Operations',
  ],
  'developer-automation': [
    'Code Editor, File Explorer, Search, Diff, and Refactor',
    'Terminal, Shell, Processes, and Environment Management',
    'Git, Branch, Commit, Pull Request, and Code Review', 'Browser Computer Use and Web QA',
    'Windows Desktop Computer Use and UI Automation', 'MCP, APIs, Connectors, and Tool Development',
    'Agents, Subagents, Workflows, Goals, and Scheduling',
    'Testing, CI/CD, Deployment, Observability, and Rollback',
  ],
  'creative-media': [
    'Product, UI/UX, and Web Design', 'Image Generation, Editing, Upscaling, and Comparison',
    'Video Generation, Editing, Encoding, and Subtitles',
    'Motion Graphics, Remotion, and Interactive Animation',
    'Audio, Voice, Music, STT, and TTS Production',
    '3D Assets, Blender, Three.js, glTF, and Rendering',
    'Figma, Canva, Design Systems, and Design-to-Code',
    'Brand, Presentation, Avatar, and Creative Production',
  ],
  'research-knowledge': [
    'Web Search and Deep Research', 'Enterprise File, Drive, and Workspace Search',
    'Technical Documentation and Source Retrieval',
    'Citations, Evidence, Provenance, and Fact Verification',
    'Market, Competitive, Commercial, and Customer Research',
    'Scientific, Academic, Patent, and Standards Research',
    'Knowledge Capture, Memory, Lessons, and Reuse',
    'Translation, Summarization, and Multilingual Analysis',
  ],
  'infrastructure-ai-compute': [
    'Model and Provider Registry', 'Local Model Discovery and Admission',
    'Compute Resource Broker and Capacity Planner', 'GPU Discovery, Health, Scheduling, and Leasing',
    'Model Serving, Loading, Warming, and Unloading',
    'Route Selection, Queueing, Failover, and Cancellation',
    'Speech, Vision, Image, Video, and Embedding Runtime Routes',
    'Usage, Token, Cost, Balance, Trace, and Performance Analytics',
  ],
  'models-providers': [
    'DeepSeek Models and Coding Plans', 'Qwen and Alibaba Open Models',
    'OpenAI Models and Official Sign-In/API Routes',
    'Anthropic Models and Official Sign-In/API Routes', 'xAI/Grok Models and API Routes',
    'Kimi/Moonshot Models and Coding Routes', 'GLM/Z.ai Models and Coding Routes',
    'OpenAI-Compatible and Custom Local/Remote Providers',
  ],
  'security-governance': [
    'Credential and Secret Mediation', 'Identity, Passkey, Authentication, and Session Security',
    'Approval, Policy, Scope, and Principal-Bound Actions',
    'Sandbox, Filesystem, Network, and Tool Boundaries',
    'Redaction, Privacy, Data Boundary, and No-Export Controls',
    'Security Scan, Threat Model, Vulnerability, and Incident Response',
    'Audit, Evidence Ledger, Provenance, and Exactly-Once Actions',
    'Signed Updates, Migration, Backup, Recovery, and Rollback',
  ],
}

const STATE_OVERRIDES: Readonly<Record<string, PublicFeatureState>> = {
  'Universal File and Artifact Viewer': 'NEEDS_RUNTIME',
  'OCR, MarkItDown, and Structured Extraction': 'INSTALLED',
  'Indonesian Dictation and Speech Playback': 'ENABLED',
  'Code Editor, File Explorer, Search, Diff, and Refactor': 'INSTALLED',
  'Terminal, Shell, Processes, and Environment Management': 'INSTALLED',
  'Git, Branch, Commit, Pull Request, and Code Review': 'INSTALLED',
  'Browser Computer Use and Web QA': 'READY',
  'Windows Desktop Computer Use and UI Automation': 'READY',
  'Agents, Subagents, Workflows, Goals, and Scheduling': 'INSTALLED',
  'Testing, CI/CD, Deployment, Observability, and Rollback': 'INSTALLED',
  'Model and Provider Registry': 'REGISTERED',
  'Local Model Discovery and Admission': 'DEGRADED',
  'Compute Resource Broker and Capacity Planner': 'NEEDS_RUNTIME',
  'GPU Discovery, Health, Scheduling, and Leasing': 'NEEDS_RUNTIME',
  'Model Serving, Loading, Warming, and Unloading': 'NEEDS_RUNTIME',
  'Route Selection, Queueing, Failover, and Cancellation': 'NEEDS_RUNTIME',
  'Speech, Vision, Image, Video, and Embedding Runtime Routes': 'DEGRADED',
  'Usage, Token, Cost, Balance, Trace, and Performance Analytics': 'INSTALLED',
  'Qwen and Alibaba Open Models': 'READY',
  'OpenAI Models and Official Sign-In/API Routes': 'NEEDS_SIGN_IN',
  'Anthropic Models and Official Sign-In/API Routes': 'NEEDS_SIGN_IN',
  'Credential and Secret Mediation': 'REGISTERED',
  'Security Scan, Threat Model, Vulnerability, and Incident Response': 'INSTALLED',
  'Signed Updates, Migration, Backup, Recovery, and Rollback': 'INSTALLED',
}

const DETAIL_OVERRIDES: Readonly<Record<string, string>> = {
  'Universal File and Artifact Viewer': 'Inspector consolidation is implemented; format-specific current canaries remain required.',
  'OCR, MarkItDown, and Structured Extraction': 'MarkItDown is installed; approved-build end-to-end proof is pending.',
  'Indonesian Dictation and Speech Playback': 'Microphone UI and Indonesian STT/TTS round trip passed; DOTS remains a preferred route with an Indonesian fallback when unavailable.',
  'Browser Computer Use and Web QA': 'Playwright MCP registered 46 tools; navigation, snapshot, screenshot, governed code, and file-upload canaries passed.',
  'Windows Desktop Computer Use and UI Automation': 'Windows MCP registered 20 UIA, OCR, screenshot, mouse, keyboard, window, and macro tools; desktop-state and screenshot canaries passed without mutating input.',
  'Qwen and Alibaba Open Models': 'Qwen3.8-27B on R5300 passed live text and structured agent tool-call canaries through Giana Code.',
  'Compute Resource Broker and Capacity Planner': 'R5300-first and PRDG-fallback capacity-aware selection is not yet materialized.',
  'GPU Discovery, Health, Scheduling, and Leasing': 'Cross-host GPU inventory and leasing require a current typed compute backend.',
  'OpenAI Models and Official Sign-In/API Routes': 'Official account sign-in must complete outside chat before this route can become ready.',
  'Anthropic Models and Official Sign-In/API Routes': 'Official account sign-in must complete outside chat before this route can become ready.',
}

let nextId = 1
export const PUBLIC_FEATURES: readonly PublicFeature[] = PUBLIC_FEATURE_CATEGORIES.flatMap(category => (
  TITLES[category].map((title) => {
    const state = STATE_OVERRIDES[title] ?? 'DISCOVERABLE'
    const detail = DETAIL_OVERRIDES[title]
      ?? (state === 'DISCOVERABLE'
        ? 'Catalogued for discovery. Installation, registration, and runtime readiness are not implied.'
        : 'Source-backed component state; current runtime readiness is shown separately.')
    return {
      id: nextId++,
      title,
      category,
      state,
      runtimeState: 'DISCOVERABLE' as const,
      detail: state === 'DISCOVERABLE'
        ? detail
        : `${detail} Declared source state: ${state}; this view has no live runtime receipt for it.`,
    }
  })
))

if (PUBLIC_FEATURES.length !== 96) {
  throw new Error(`Public feature catalog must contain exactly 96 entries; found ${PUBLIC_FEATURES.length}`)
}

export const CATALOG_SUMMARIES = {
  skills: {
    total: 647,
    state: 'DEGRADED' as PublicFeatureState,
    detail: '392 skills have historical runtime evidence; 255 still need a connector, dependency, sign-in, hardware, or runtime.',
  },
  connectors: {
    total: 1409,
    secondary: 14799,
    state: 'DISCOVERABLE' as PublicFeatureState,
    detail: 'Providers and actions are catalogued and loaded on demand. Connection and authentication are provider-specific.',
  },
  marketplace: {
    total: 4826,
    secondary: 5,
    state: 'DISCOVERABLE' as PublicFeatureState,
    detail: 'Remote items are discoverable and untrusted by default; five local components were observed by the install scan.',
  },
} as const
