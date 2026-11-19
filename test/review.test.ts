import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewStore } from '../src/core/review';

test('independent hunk decisions preserve rejected and pending content', () => {
  const store = new ReviewStore();
  const original = 'one\nkeep\nthree\nkeep again\nfive\n';
  const proposal = store.propose('src/example.ts', original, 'ONE\nkeep\nTHREE\nkeep again\nFIVE\n');
  assert.equal(proposal.hunks.length, 3);
  store.decide(proposal.hunks[0]!.id, false);
  store.decide(proposal.hunks[2]!.id, true);
  assert.deepEqual(store.acceptedEdits(), [{
    path: 'src/example.ts', original, updated: 'one\nkeep\nthree\nkeep again\nFIVE\n',
  }]);
});

test('insertions, deletions and missing final newlines preserve exact text', () => {
  for (const [original, proposed] of [
    ['first\nlast', 'intro\nfirst\nlast\nend'],
    ['first\nremove\nlast\n', 'first\nlast\n'],
    ['one\r\ntwo\r\n', 'ONE\r\ntwo\r\n'],
    ['one\n', 'one'],
    ['', 'hello'],
    ['hello', ''],
    ['😀\nkeep\nold', '🎉\nkeep\nnew'],
  ]) {
    const store = new ReviewStore();
    const proposal = store.propose('file', original!, proposed!);
    proposal.hunks.forEach((hunk) => store.decide(hunk.id, true));
    assert.equal(store.acceptedEdits()[0]?.updated, proposed);
  }
});

test('file creation is distinct from editing an empty file', () => {
  const store = new ReviewStore();
  const creation = store.propose('empty.txt', null, '');
  assert.equal(creation.hunks.length, 1);
  store.decide(creation.hunks[0]!.id, true);
  assert.deepEqual(store.acceptedEdits(), [{ path: 'empty.txt', original: null, updated: '' }]);
  const unchanged = store.propose('existing.txt', '', '');
  assert.equal(unchanged.hunks.length, 0);
});

test('a subsequent edit retains the original snapshot and expires old decisions', () => {
  const store = new ReviewStore();
  const first = store.propose('file', 'a\nb\n', 'A\nb\n');
  store.decide(first.hunks[0]!.id, true);
  const second = store.propose('file', first.proposed, 'A\nB\n');
  assert.equal(second.original, 'a\nb\n');
  assert.ok(second.hunks.every((hunk) => hunk.decision === 'pending'));
  assert.throws(() => store.decide(first.hunks[0]!.id, true), /expired/);
  assert.throws(() => store.propose('file', 'a\nb\n', 'a\nB\n'), /stale/);
  second.hunks.forEach((hunk) => store.decide(hunk.id, true));
  assert.equal(store.acceptedEdits()[0]?.updated, 'A\nB\n');
});

test('a retried proposal preserves decisions', () => {
  const store = new ReviewStore();
  const first = store.propose('file', 'old', 'new');
  store.decide(first.hunks[0]!.id, false);
  const retried = store.propose('file', 'old', 'new');
  assert.equal(retried.id, first.id);
  assert.equal(retried.hunks[0]!.decision, 'rejected');
});

test('external mutation and late events cannot change another run', () => {
  const store = new ReviewStore();
  const first = store.propose('file', 'old', 'new');
  first.hunks[0]!.decision = 'accepted';
  store.list()[0]!.hunks[0]!.newText = 'corrupted';
  assert.deepEqual(store.acceptedEdits(), []);
  store.clear();
  store.propose('file', 'old', 'another');
  assert.throws(() => store.decide(first.hunks[0]!.id, true), /expired/);
  assert.deepEqual(store.acceptedEdits(), []);
});

test('relative paths are normalized and traversal paths rejected', () => {
  const store = new ReviewStore();
  assert.equal(store.propose('src\\file.ts', 'old', 'new').path, 'src/file.ts');
  for (const path of ['', '/tmp/file', '../file', 'src/../file', './file', 'C:\\file', 'a//b', 'a\0b']) {
    assert.throws(() => store.propose(path, '', 'new'), /relative workspace/);
  }
});
