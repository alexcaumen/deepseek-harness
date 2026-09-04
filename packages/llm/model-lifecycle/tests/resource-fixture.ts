import type { ResourceLeaseProvider } from '../src/index.ts'
import { ResourceLeaseRef, ResourceLeaseIssuerRef, ResourceLeaseHolderRef } from '../src/resource-lease.ts'

/** Test-only grants. This fixture does not provide distributed exclusion or authenticate an issuer. */
export function fixtureResources(): ResourceLeaseProvider {
  let sequence = 0
  return {
    acquire: async request => ({
      leaseRef: ResourceLeaseRef(`fixture-lease-${++sequence}`),
      issuerRef: ResourceLeaseIssuerRef('fixture-issuer'), holderRef: ResourceLeaseHolderRef('fixture-app'), targets: [...request.targets],
      fencingDigest: `sha256:${'f'.repeat(64)}`, receiptDigest: `sha256:${'e'.repeat(64)}`,
      expiresAt: Date.now() + 60_000, renewAfterMs: 20_000,
    }),
    renew: async grant => ({
      ...grant, expiresAt: Date.now() + 60_000, renewAfterMs: 20_000,
      receiptDigest: `sha256:${(++sequence).toString(16).padStart(64, '0')}`,
    }),
    release: async () => {},
  }
}
