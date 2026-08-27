import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../knowledge-governance-admin-prototype.html', import.meta.url), 'utf8');

test('prototype keeps the three approved views', () => {
  for (const id of ['dashboard', 'wizard', 'catalog']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('catalog exposes the complete document lifecycle', () => {
  for (const id of ['createDocument', 'changeDocument', 'retireDocument', 'maintainDirectory']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('catalog exposes governance detail tabs', () => {
  for (const tab of ['overview', 'permissions', 'changes', 'audit']) {
    assert.match(html, new RegExp(`data-detail-tab=["']${tab}["']`));
  }
});
