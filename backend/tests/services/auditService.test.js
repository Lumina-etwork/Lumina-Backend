jest.mock('../../src/models', () => ({
  AdminAuditLog: {
    findOne: jest.fn(),
    build: jest.fn(),
    findAll: jest.fn(),
  },
}));

jest.mock('../../src/services/metricsService', () => ({
  auditEventsTotal: { inc: jest.fn() },
  auditVerificationTotal: { inc: jest.fn() },
  auditHashChainVerifiedEntries: { set: jest.fn() },
}));

const { AdminAuditLog } = require('../../src/models');
const AuditService = require('../../src/services/auditService');
const { GENESIS_HASH, computeAuditHash } = require('../../src/services/auditHashChain');

const makeLog = (overrides = {}) => {
  const entry = {
    id: overrides.id || '11111111-1111-4111-8111-111111111111',
    admin_pubkey: 'GADMIN',
    action: 'APPROVE_KYC',
    ip_address: '127.0.0.1',
    payload: { status: 'approved', nested: { b: 2, a: 1 } },
    resource_id: 'kyc-1',
    timestamp: new Date('2026-07-18T00:00:00.000Z'),
    sequence_number: 1,
    previous_hash: GENESIS_HASH,
    ...overrides,
  };
  entry.audit_hash = overrides.audit_hash || computeAuditHash(entry);
  return entry;
};

describe('AuditService hash chain', () => {
  beforeEach(() => jest.clearAllMocks());

  test('logAction stores previous hash, sequence, and computed audit hash', async () => {
    AdminAuditLog.findOne.mockResolvedValue({ audit_hash: 'a'.repeat(64), sequence_number: 7 });
    const saved = {};
    AdminAuditLog.build.mockImplementation((data) => ({
      ...data,
      id: '22222222-2222-4222-8222-222222222222',
      toJSON() { return { ...this }; },
      async save() { Object.assign(saved, this); return this; },
    }));

    const result = await AuditService.logAction({
      adminPubkey: 'GADMIN',
      action: 'UPDATE_VAULT_CONFIG',
      ipAddress: '10.0.0.1',
      payload: { limit: 10 },
      resourceId: 'vault-1',
    });

    expect(result.sequence_number).toBe(8);
    expect(result.previous_hash).toBe('a'.repeat(64));
    expect(saved.audit_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.audit_hash).toBe(computeAuditHash(saved));
  });

  test('verifyHashChain returns valid for an intact ordered chain', async () => {
    const first = makeLog();
    const second = makeLog({
      id: '33333333-3333-4333-8333-333333333333',
      sequence_number: 2,
      previous_hash: first.audit_hash,
      timestamp: new Date('2026-07-18T00:00:01.000Z'),
    });
    AdminAuditLog.findAll.mockResolvedValue([first, second].map((entry) => ({ toJSON: () => entry })));

    const result = await AuditService.verifyHashChain();

    expect(result).toMatchObject({
      valid: true,
      checked: 2,
      first_sequence: 1,
      last_sequence: 2,
      head_hash: second.audit_hash,
      mismatches: [],
    });
  });

  test('verifyHashChain reports the first tampered entry', async () => {
    const first = makeLog({ payload: { status: 'tampered' } });
    AdminAuditLog.findAll.mockResolvedValue([{ toJSON: () => ({ ...first, audit_hash: 'b'.repeat(64) }) }]);

    const result = await AuditService.verifyHashChain();

    expect(result.valid).toBe(false);
    expect(result.mismatches[0]).toMatchObject({
      id: first.id,
      sequence_number: 1,
      field: 'audit_hash',
      actual: 'b'.repeat(64),
    });
  });
});
