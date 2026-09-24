import test from 'node:test';
import assert from 'node:assert/strict';
import { isOperatorIdentity } from '../src/lib/operator-access.ts';

const operator = 'aa'.repeat(28), team = 'bb'.repeat(28), admin = 'cc'.repeat(28);
const identity = hash => ({ networkId: 0, paymentCredential: { type: 'Key', hash } });
test('operator, Team and factory creator credentials are eligible', () => {
  for (const hash of [operator, team, admin]) assert.equal(isOperatorIdentity(identity(hash), [operator, team, admin]), true);
});
test('unknown keys, script credentials, mainnet, missing credentials and invalid configuration are denied', () => {
  assert.equal(isOperatorIdentity(identity('dd'.repeat(28)), [operator, team]), false);
  assert.equal(isOperatorIdentity({ ...identity(operator), networkId: 1 }, [operator]), false);
  assert.equal(isOperatorIdentity({ networkId: 0, paymentCredential: { type: 'Script', hash: operator } }, [operator]), false);
  assert.equal(Boolean(isOperatorIdentity({ networkId: 0 }, [operator])), false);
  assert.equal(isOperatorIdentity(identity(operator), ['', 'invalid']), false);
  assert.equal(isOperatorIdentity(identity('invalid'), ['invalid']), false);
});
