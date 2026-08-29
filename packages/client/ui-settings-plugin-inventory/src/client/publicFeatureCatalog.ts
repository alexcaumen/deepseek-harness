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

/** A catalog row is a discoverable claim, not runtime evidence. */
export type PublicFeatureClaim = 'discoverable'

export interface PublicFeature {
  readonly id: number
  readonly title: string
  readonly category: PublicFeatureCategory
  readonly claim: PublicFeatureClaim
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

const CATALOG_CLAIM_DETAIL = 'Discoverable catalog claim only. Installation, enablement, connection, callability, behavioral proof, and hold state require live runtime evidence.'

let nextId = 1
export const PUBLIC_FEATURES: readonly PublicFeature[] = PUBLIC_FEATURE_CATEGORIES.flatMap(category => (
  TITLES[category].map(title => ({
    id: nextId++,
    title,
    category,
    claim: 'discoverable' as const,
    detail: CATALOG_CLAIM_DETAIL,
  }))
))

if (PUBLIC_FEATURES.length !== 96) {
  throw new Error(`Public feature catalog must contain exactly 96 entries; found ${PUBLIC_FEATURES.length}`)
}
