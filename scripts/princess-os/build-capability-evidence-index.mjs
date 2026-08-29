import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const candidateRoot = path.resolve(
  process.env.DSH_CANDIDATE_ROOT ?? 'N:/worktrees/deepseek-harness/giana-code-putri-20260827',
);
const outputDir = path.join(candidateRoot, '.artifacts', 'capability-evidence-index-final');
const outputPath = path.join(outputDir, 'capability-evidence-index.json');

const evidence = [
  {
    id: 'connector-catalog',
    family: 'catalog',
    state: 'DISCOVERABLE_NOT_CONNECTED_BY_DEFAULT',
    callableScope: 'catalog metadata only',
    path: 'apps/web/public/giana-catalogs/connectors.json',
    note: '1,409 providers and 14,799 actions are catalogued; catalog presence is not connection or runtime proof.',
  },
  {
    id: 'marketplace-catalog',
    family: 'catalog',
    state: 'DISCOVERABLE_UNVERIFIED',
    callableScope: 'catalog metadata only',
    path: 'apps/web/public/giana-catalogs/marketplace.json',
    note: '4,826 entries are discoverable; installation, trust, and runtime readiness are not implied.',
  },
  {
    id: 'skill-catalog',
    family: 'catalog',
    state: 'MIXED_HISTORICAL_EVIDENCE',
    callableScope: 'catalog metadata plus historical evidence',
    path: 'apps/web/public/giana-catalogs/skills.json',
    note: '647 skills are indexed; 392 have historical evidence and 255 still need runtime or connector proof.',
  },
  {
    id: 'browser-computer-use',
    family: 'computer-use',
    state: 'PASS_BEHAVIORAL_ISOLATED',
    callableScope: 'candidate isolated headless Chrome only',
    path: '.artifacts/computer-use-canary-current/computer-use-canary.json',
    note: 'Does not attach to the user visible Chrome profile.',
  },
  {
    id: 'windows-desktop-computer-use',
    family: 'computer-use',
    state: 'PASS_BEHAVIORAL_FIXTURE_ONLY',
    callableScope: 'disposable candidate fixture only',
    path: '.artifacts/windows-desktop-live-actions/windows-desktop-live-actions.json',
    note: 'Mouse, keyboard, window, screenshot, and reversible fixture actions passed.',
  },
  {
    id: 'office-file-tools',
    family: 'files',
    state: 'PASS_BEHAVIORAL_CANDIDATE_ONLY',
    callableScope: 'candidate artifacts only',
    path: '.artifacts/office-canary-current/office-canary.json',
    note: 'XLSX, PDF, PPTX, and DOCX create/read canaries passed.',
  },
  {
    id: 'qwen-route',
    family: 'model',
    state: 'PASS_BEHAVIORAL_ROUTE_CANARY',
    callableScope: 'Qwen endpoint route canary',
    path: '.artifacts/qwen-route-canary-final/qwen-route-canary.json',
    note: 'Text, tool, parallel-tool, vision, stream, and cancel cases passed.',
  },
  {
    id: 'speech',
    family: 'speech',
    state: 'PARTIAL_STT_PASS_TTS_FALLBACK',
    callableScope: 'STT route passed; DOTS TTS route remains held',
    path: '.artifacts/speech-canary-final/speech-canary.json',
    note: 'Indonesian STT used CUDA-eligible PRDG route; TTS used fallback engine.',
  },
  {
    id: 'workbench-heqa',
    family: 'ui',
    state: 'PASS_HEQA_CANDIDATE',
    callableScope: 'candidate web runtime',
    path: '.artifacts/heqa-current/HEQA_DSH_PRINCESS_OS_WORKBENCH_20260822.json',
    note: 'Two viewport HEQA covered dictation, send, pane controls, files, terminal, and browser surfaces.',
  },
  {
    id: 'copy-recovery',
    family: 'ui',
    state: 'PASS_HEQA_CANDIDATE',
    callableScope: 'candidate Kirana fixture',
    path: '.artifacts/kirana-copy-recovery-final-rerun2/giana-code-kirana-copy-recovery-heqa-20260827.json',
    note: 'Clipboard fallback and copy interaction passed in the controlled fixture.',
  },
  {
    id: 'notifications',
    family: 'notifications',
    state: 'IMPLEMENTED_TEST_BACKED_RUNTIME_DELIVERY_UNPROVEN',
    callableScope: 'client and desktop bridge source/tests',
    path: null,
    note: 'At-most-once classification/dedupe is covered; native live delivery is not proven.',
  },
  {
    id: 'putri-native-tools',
    family: 'gianaos-bridge',
    state: 'HELD_CANONICAL_ATTACH_GAP',
    callableScope: 'not claimed callable through canonical Putri',
    path: '.artifacts/putri-native-tools-canary-final/putri-native-tools-canary.json',
    note: 'Canonical ACP lacks a non-persisting session attach/canary method.',
  },
  {
    id: 'goal-terminal-filesystem-jobs-skills-connectors',
    family: 'native-tools',
    state: 'HELD_NO_LIVE_CANONICAL_PROOF',
    callableScope: 'source/test-backed only until canonical attach is proven',
    path: null,
    note: 'No live canonical Putri invocation is inferred from package presence or UI labels.',
  },
];

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function inspect(item) {
  if (!item.path) {
    return { ...item, artifact: null };
  }

  const absolutePath = path.join(candidateRoot, item.path);
  if (!fs.existsSync(absolutePath)) {
    return { ...item, artifact: { path: absolutePath, exists: false } };
  }

  let topLevelKeys = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      topLevelKeys = Object.keys(parsed).sort();
    }
  } catch {
    topLevelKeys = ['<invalid-json>'];
  }

  return {
    ...item,
    artifact: {
      path: absolutePath,
      exists: true,
      bytes: fs.statSync(absolutePath).size,
      sha256: sha256(absolutePath),
      topLevelKeys,
    },
  };
}

const report = {
  schemaVersion: 1,
  reportKind: 'giana-code-putri-capability-evidence-index',
  candidateRoot,
  generatedBy: 'build-capability-evidence-index.mjs',
  sourceOnly: true,
  capabilities: evidence.map(inspect),
  interpretation: {
    passMeans: 'The named isolated candidate canary recorded behavioral success.',
    heldMeans: 'The capability is not claimed callable or current without the named proof.',
    protectedBoundaries: [
      'preserved old runtime untouched',
      'user Chrome/profile untouched',
      'canonical GianaOS runtime untouched',
      'no model prompt dispatched by this indexer',
    ],
  },
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, sha256: sha256(outputPath), count: report.capabilities.length }, null, 2));
