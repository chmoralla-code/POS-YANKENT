'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const releaseNotes = require('../src/renderer/js/release-notes');

test('GitHub HTML notes become clean grouped highlights', () => {
  const groups = releaseNotes.parse('<p>Secure remote updates, printer recovery, reports, cashier, and UI improvements.</p>');

  assert.deepEqual(groups.map((group) => group.label), [
    'Security & safety',
    'Reliability fixes',
    'New & improved',
  ]);
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.text)), [
    'Secure remote updates',
    'Printer recovery',
    'Reports',
    'Cashier',
    'UI improvements',
  ]);
  assert.equal(groups.flatMap((group) => group.items).some((item) => /<\/?p>/i.test(item.text)), false);
});

test('HTML lists preserve item boundaries and remove active markup', () => {
  const lines = releaseNotes.normalize(`
    <h2>Fixes</h2>
    <ul><li>Printer &amp; scanner recovery</li><li>Faster checkout</li></ul>
    <script>globalThis.compromised = true</script>
    <img src="https://invalid.example/tracker.png" onerror="steal()">
  `);

  assert.deepEqual(lines, ['## Fixes', '- Printer & scanner recovery', '- Faster checkout']);
  assert.equal(lines.join(' ').includes('compromised'), false);
  assert.equal(lines.join(' ').includes('tracker'), false);
});

test('Markdown headings and numbered items remain readable', () => {
  const groups = releaseNotes.parse('### Printer updates\n1. Fixed disconnected printer recovery\n2. Added a safer test print');

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Printer updates');
  assert.deepEqual(groups[0].items.map((item) => item.text), [
    'Fixed disconnected printer recovery',
    'Added a safer test print',
  ]);
});

test('electron-updater full changelog arrays retain version sections', () => {
  const groups = releaseNotes.parse([
    { version: '2.2.6', note: '<p>Added safer reports</p>' },
    { version: '2.2.5', note: '<p>Fixed printer recovery</p>' },
  ]);

  assert.deepEqual(groups.map((group) => group.label), ['Version 2.2.6', 'Version 2.2.5']);
  assert.deepEqual(groups.map((group) => group.items[0].text), ['Added safer reports', 'Fixed printer recovery']);
});

test('unclassified prose uses a helpful fallback instead of Other', () => {
  const groups = releaseNotes.parse('<p>Updated construction supply catalog wording.</p>');

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Release highlights');
  assert.equal(groups[0].items[0].text, 'Updated construction supply catalog wording.');
});

test('empty or missing notes produce no groups', () => {
  assert.deepEqual(releaseNotes.parse(''), []);
  assert.deepEqual(releaseNotes.parse(null), []);
  assert.deepEqual(releaseNotes.parse([]), []);
});

test('named, decimal, and hexadecimal entities decode safely', () => {
  assert.equal(releaseNotes.htmlToPlainText('<p>Cash &amp; credit &#8212; build &#x2713;</p>'), 'Cash & credit — build ✓');
});

test('encoded comparison signs remain readable text', () => {
  assert.equal(releaseNotes.htmlToPlainText('<p>Use A &lt; B and C &gt; D</p>'), 'Use A < B and C > D');
});

test('ordinary comma-separated prose stays one accurate highlight', () => {
  const groups = releaseNotes.parse('<p>Fixed report totals, which were incorrect, and improved printing.</p>');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Reliability fixes');
  assert.equal(groups[0].items[0].text, 'Fixed report totals, which were incorrect, and improved printing.');

  const branchGroups = releaseNotes.parse('<p>Supports Cebu, Davao, and Manila branches.</p>');
  assert.equal(branchGroups.flatMap((group) => group.items).length, 1);
});

test('specific security and fix signals outrank broad feature words', () => {
  assert.equal(releaseNotes.parse('- Fixed cashier crash')[0].label, 'Reliability fixes');
  assert.equal(releaseNotes.parse('- Secure UI permissions')[0].label, 'Security & safety');
});
