import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const tunnelScript = fileURLToPath(new URL('./Start-GianaCodeToolBridgeTunnel.ps1', import.meta.url))

/** Pinned identity and route values shared by every GianaOS VM SSH child command. */
export const PUTRI_ACP_SSH_CONFIG = Object.freeze({
  vmId: '900',
  vmUser: 'debian',
  pinnedVmHostAlias: '192.168.1.58',
})

const PINNED_VM_IDENTITY_OPTIONS = Object.freeze([
  '-o', `HostKeyAlias=${PUTRI_ACP_SSH_CONFIG.pinnedVmHostAlias}`,
  '-o', 'StrictHostKeyChecking=yes',
])

/**
 * Builds one independent SSH command for the R5300-to-GianaOS VM hop.
 *
 * @param {{vmAddress: string, connectTimeoutSeconds: number, remoteCommand: string[], exec?: boolean, disablePseudoTerminal?: boolean, separator?: boolean}} options Command options.
 * @returns {string[]} A fresh argument array containing the pinned VM host identity.
 */
export function buildNestedVmSshCommand({
  vmAddress,
  connectTimeoutSeconds,
  remoteCommand,
  exec = false,
  disablePseudoTerminal = false,
  separator = false,
}) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(vmAddress)) {
    throw new TypeError('GianaOS VM address must be an IPv4 address')
  }
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds <= 0) {
    throw new TypeError('SSH connect timeout must be a positive integer')
  }
  if (!Array.isArray(remoteCommand) || remoteCommand.length === 0
    || remoteCommand.some(argument => typeof argument !== 'string' || argument.length === 0)) {
    throw new TypeError('Nested SSH remote command must contain non-empty string arguments')
  }

  return [
    ...(exec ? ['exec'] : []),
    'ssh',
    ...(disablePseudoTerminal ? ['-T'] : []),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    ...PINNED_VM_IDENTITY_OPTIONS,
    `${PUTRI_ACP_SSH_CONFIG.vmUser}@${vmAddress}`,
    ...(separator ? ['--'] : []),
    ...remoteCommand,
  ]
}

/**
 * Redacts credentials and compresses child-process diagnostics to one bounded line.
 *
 * @param {unknown} value Raw child-process diagnostic text.
 * @returns {string} A redacted diagnostic suitable for the launcher stderr stream.
 */
export function redactChildDiagnostic(value) {
  if (value === undefined || value === null) return ''
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '<redacted-url>')
    .replace(/\bBearer\s+[^\s;,]+/gi, 'Bearer <redacted>')
    .replace(
      /(\b(?:authorization|[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      '$1<redacted>',
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

/**
 * Formats a causal, redacted child-process failure.
 *
 * @param {string} label Operation label.
 * @param {{error?: Error & {code?: string}, status?: number | null, signal?: string | null, stderr?: unknown}} result Child-process outcome.
 * @returns {string} A causal failure message with redacted child diagnostics.
 */
export function formatChildFailure(label, result) {
  let outcome
  if (result.error !== undefined) {
    const code = typeof result.error.code === 'string' ? `${result.error.code}: ` : ''
    const detail = redactChildDiagnostic(result.error.message || result.error.name)
    outcome = `could not start (${code}${detail || 'unknown spawn error'})`
  } else if (result.signal !== undefined && result.signal !== null) {
    outcome = `was terminated by ${redactChildDiagnostic(result.signal)}`
  } else if (typeof result.status === 'number') {
    outcome = `exited with status ${result.status}`
  } else {
    outcome = 'ended without an exit status'
  }
  const stderr = redactChildDiagnostic(result.stderr)
  return `${label} ${outcome}${stderr === '' ? '' : `; stderr: ${stderr}`}`
}

function main() {
  function fail(message) {
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }

  function capture(args, label) {
    const result = spawnSync(SSH, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    if (result.error !== undefined || result.status !== 0) {
      fail(formatChildFailure(label, result))
    }
    return result.stdout
  }

  const tunnel = spawnSync(POWERSHELL, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    tunnelScript,
    '-VmId',
    PUTRI_ACP_SSH_CONFIG.vmId,
    '-PinnedVmHostAlias',
    PUTRI_ACP_SSH_CONFIG.pinnedVmHostAlias,
  ], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
  if (tunnel.error !== undefined || tunnel.status !== 0) {
    fail(formatChildFailure('Giana Code tool bridge tunnel', tunnel))
  }

  const config = capture([
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300', `qm config ${PUTRI_ACP_SSH_CONFIG.vmId}`,
  ], 'GianaOS VM inspection')
  const mac = config.match(/net0:\s+\S+=([0-9A-Fa-f:]{17})/)?.[1]?.toLowerCase()
  if (mac === undefined) fail('GianaOS VM MAC address is unavailable')

  const neighbours = capture([
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300', 'ip neigh show',
  ], 'R5300 neighbour inspection')
  const vmAddress = neighbours.split(/\r?\n/)
    .find(line => line.toLowerCase().includes(`lladdr ${mac}`) && !line.includes('FAILED'))
    ?.trim().split(/\s+/)[0]
  if (vmAddress === undefined || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(vmAddress)) {
    fail('GianaOS VM address is unavailable')
  }

  const service = capture([
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300',
    ...buildNestedVmSshCommand({
      vmAddress,
      connectTimeoutSeconds: 5,
      remoteCommand: [
        'sudo', '-n', 'systemctl', 'show', 'gianaos-putri.service', '-p', 'ExecStart', '--value',
      ],
    }),
  ], 'Canonical Putri service inspection')
  const wrapper = service.match(/path=([^\s;]+)/)?.[1]
  if (wrapper === undefined || !wrapper.startsWith('/usr/local/libexec/gianaos-putri-')) {
    fail('Canonical Putri service wrapper identity is invalid')
  }
  const wrapperSource = capture([
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300',
    ...buildNestedVmSshCommand({
      vmAddress,
      connectTimeoutSeconds: 5,
      remoteCommand: ['sudo', '-n', 'cat', wrapper],
    }),
  ], 'Canonical Putri executable inspection')
  const executable = wrapperSource.match(/\/opt\/gianaos\/venvs\/[A-Za-z0-9._-]+\/bin\/gianaos/)?.[0]
  if (executable === undefined) fail('Canonical Putri executable pointer is missing')

  const nestedCommand = buildNestedVmSshCommand({
    vmAddress,
    connectTimeoutSeconds: 10,
    exec: true,
    disablePseudoTerminal: true,
    separator: true,
    remoteCommand: [
      'sudo', '-n',
      'systemd-run', '--quiet', '--pipe', '--wait', '--collect',
      '--service-type=exec',
      '--uid=gianaos', '--gid=gianaos',
      '--setenv=HOME=/var/lib/gianaos',
      '--setenv=GIANAOS_HOME=/var/lib/gianaos',
      '--setenv=HERMES_HOME=/var/lib/gianaos',
      '--setenv=PYTHONDONTWRITEBYTECODE=1',
      '--setenv=PYTHONUNBUFFERED=1',
      '--working-directory=/srv/gianaos-data/objects/putri',
      '--property=EnvironmentFile=/var/lib/gianaos/profiles/putri/.env',
      executable, '-p', 'putri', 'acp',
    ],
  }).join(' ')

  const acp = spawn(SSH, [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    'r5300',
    nestedCommand,
  ], { stdio: 'inherit', windowsHide: true })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { acp.kill(signal) })
  }
  acp.once('error', error => {
    fail(formatChildFailure('Canonical Putri ACP transport', { error }))
  })
  acp.once('exit', (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal)
      return
    }
    if (code !== 0) {
      process.stderr.write(`${formatChildFailure('Canonical Putri ACP transport', { status: code })}\n`)
    }
    process.exit(code ?? 1)
  })
}

const launcherPath = fileURLToPath(import.meta.url)
const argvPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1])
const isDirectRun = argvPath !== undefined && (process.platform === 'win32'
  ? argvPath.toLowerCase() === launcherPath.toLowerCase()
  : argvPath === launcherPath)
if (isDirectRun) main()
