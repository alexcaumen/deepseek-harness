import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VM_ID = '900'
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const tunnelScript = fileURLToPath(new URL('./Start-GianaCodeToolBridgeTunnel.ps1', import.meta.url))

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
  if (result.status !== 0) fail(`${label} failed`)
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
  VM_ID,
], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
if (tunnel.status !== 0) fail('Giana Code tool bridge tunnel is unavailable')

const config = capture([
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
  'r5300', `qm config ${VM_ID}`,
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

const nestedPrefix = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
  'r5300',
  'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
  `debian@${vmAddress}`,
]
const service = capture([
  ...nestedPrefix,
  'sudo', '-n', 'systemctl', 'show', 'gianaos-putri.service', '-p', 'ExecStart', '--value',
], 'Canonical Putri service inspection')
const wrapper = service.match(/path=([^\s;]+)/)?.[1]
if (wrapper === undefined || !wrapper.startsWith('/usr/local/libexec/gianaos-putri-')) {
  fail('Canonical Putri service wrapper identity is invalid')
}
const wrapperSource = capture([
  ...nestedPrefix,
  'sudo', '-n', 'cat', wrapper,
], 'Canonical Putri executable inspection')
const executable = wrapperSource.match(/\/opt\/gianaos\/venvs\/[A-Za-z0-9._-]+\/bin\/gianaos/)?.[0]
if (executable === undefined) fail('Canonical Putri executable pointer is missing')

const nestedCommand = [
  'exec', 'ssh', '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  `debian@${vmAddress}`, '--',
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
].join(' ')

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
acp.once('error', () => fail('Canonical Putri ACP transport failed to start'))
acp.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
