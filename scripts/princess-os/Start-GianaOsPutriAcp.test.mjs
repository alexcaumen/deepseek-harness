import assert from 'node:assert/strict'
import { setImmediate as delayUntilImmediate } from 'node:timers/promises'
import test from 'node:test'

import {
  buildNestedVmSshCommand,
  formatChildFailure,
  PUTRI_ACP_SSH_CONFIG,
} from './Start-GianaOsPutriAcp.mjs'

const pinnedIdentity = [
  '-o', `HostKeyAlias=${PUTRI_ACP_SSH_CONFIG.pinnedVmHostAlias}`,
  '-o', 'StrictHostKeyChecking=yes',
]

test('builds inspection and ACP commands with the same pinned VM host identity', () => {
  const inspection = buildNestedVmSshCommand({
    vmAddress: '192.0.2.10',
    connectTimeoutSeconds: 5,
    remoteCommand: ['sudo', '-n', 'cat', '/usr/local/libexec/gianaos-putri-release'],
  })
  const acp = buildNestedVmSshCommand({
    vmAddress: '192.0.2.10',
    connectTimeoutSeconds: 10,
    exec: true,
    disablePseudoTerminal: true,
    separator: true,
    remoteCommand: ['/opt/gianaos/venvs/release/bin/gianaos', '-p', 'putri', 'acp'],
  })

  assert.deepEqual(inspection, [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    ...pinnedIdentity,
    'debian@192.0.2.10',
    'sudo', '-n', 'cat', '/usr/local/libexec/gianaos-putri-release',
  ])
  assert.deepEqual(acp, [
    'exec', 'ssh', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    ...pinnedIdentity,
    'debian@192.0.2.10', '--',
    '/opt/gianaos/venvs/release/bin/gianaos', '-p', 'putri', 'acp',
  ])
})

test('constructs concurrent inspection and canary child commands independently', async () => {
  const specifications = Array.from({ length: 12 }, (_, index) => {
    const canary = index % 2 === 1
    return {
      vmAddress: `192.0.2.${index + 20}`,
      connectTimeoutSeconds: canary ? 10 : 5,
      exec: canary,
      disablePseudoTerminal: canary,
      separator: canary,
      remoteCommand: canary
        ? [`/opt/gianaos/venvs/canary-${index}/bin/gianaos`, '-p', 'putri', 'acp']
        : ['sudo', '-n', 'cat', `/usr/local/libexec/gianaos-putri-${index}`],
    }
  })

  const commands = await Promise.all(specifications.map(async specification => {
    await delayUntilImmediate()
    return buildNestedVmSshCommand(specification)
  }))

  for (const [index, command] of commands.entries()) {
    const specification = specifications[index]
    assert.equal(command.filter(value => value === pinnedIdentity[1]).length, 1)
    assert.equal(command.filter(value => value === pinnedIdentity[3]).length, 1)
    assert.ok(command.indexOf(pinnedIdentity[1]) < command.indexOf(`debian@${specification.vmAddress}`))
    assert.deepEqual(command.slice(-specification.remoteCommand.length), specification.remoteCommand)
  }

  commands[0].push('post-construction-mutation')
  assert.equal(commands.slice(1).some(command => command.includes('post-construction-mutation')), false)
})

test('reports child failure causes while redacting credentials', () => {
  assert.equal(
    formatChildFailure('Canonical Putri service inspection', {
      status: 255,
      stderr: '\u001B[31mHost key verification failed\u001B[0m\nDEEPSEEK_API_KEY=secret-value',
    }),
    'Canonical Putri service inspection exited with status 255; stderr: '
      + 'Host key verification failed DEEPSEEK_API_KEY=<redacted>',
  )

  const spawnError = Object.assign(
    new Error('spawn ssh ENOENT password=hunter2 Bearer abc123 https://user:pass@example.test/path'),
    { code: 'ENOENT' },
  )
  assert.equal(
    formatChildFailure('Canonical Putri ACP transport', { error: spawnError }),
    'Canonical Putri ACP transport could not start '
      + '(ENOENT: spawn ssh ENOENT password=<redacted> Bearer <redacted> <redacted-url>)',
  )
})
