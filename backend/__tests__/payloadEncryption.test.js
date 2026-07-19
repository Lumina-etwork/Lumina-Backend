const crypto = require('crypto');
const {
  decryptSensitiveFields,
  encryptSensitiveFields,
  isEncryptedEnvelope,
} = require('../src/util/payloadEncryption');
const { payloadFieldEncryptionMiddleware } = require('../src/middleware/payloadEncryption.middleware');

const key = crypto.randomBytes(32);

describe('payload field encryption', () => {
  test('encrypts and decrypts configured sensitive fields recursively', () => {
    const payload = {
      email: 'alice@example.com',
      profile: {
        fullName: 'Alice Example',
        publicName: 'alice',
      },
      beneficiaries: [{ tax_id: '123-45-6789' }],
    };

    const encrypted = encryptSensitiveFields(payload, { key });

    expect(isEncryptedEnvelope(encrypted.email)).toBe(true);
    expect(isEncryptedEnvelope(encrypted.profile.fullName)).toBe(true);
    expect(encrypted.profile.publicName).toBe('alice');
    expect(isEncryptedEnvelope(encrypted.beneficiaries[0].tax_id)).toBe(true);
    expect(decryptSensitiveFields(encrypted, { key })).toEqual(payload);
  });

  test('does not double-encrypt existing envelopes', () => {
    const encrypted = encryptSensitiveFields({ email: 'alice@example.com' }, { key });
    const encryptedAgain = encryptSensitiveFields(encrypted, { key });

    expect(encryptedAgain).toEqual(encrypted);
  });

  test('middleware decrypts requests and encrypts responses when enabled', (done) => {
    const middleware = payloadFieldEncryptionMiddleware({ enabled: true, key });
    const encryptedBody = encryptSensitiveFields({ email: 'alice@example.com' }, { key });
    const req = { body: encryptedBody };
    const res = {
      json(body) {
        expect(req.body.email).toBe('alice@example.com');
        expect(isEncryptedEnvelope(body.email)).toBe(true);
        expect(decryptSensitiveFields(body, { key }).email).toBe('bob@example.com');
        done();
      },
      status() {
        return this;
      },
    };

    middleware(req, res, () => res.json({ email: 'bob@example.com' }));
  });
});
