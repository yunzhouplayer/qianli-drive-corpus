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

test('prototype uses only the approved Qianli palette', () => {
  const approved = new Set(['#db0052', '#000', '#fff', '#f2f2f2', '#bfbfbf', '#7f7f7f', '#404040']);
  const cssHexLiterals = html.match(/#[0-9a-f]{3,8}\b/gi) ?? [];

  for (const color of cssHexLiterals) {
    assert.ok(approved.has(color.toLowerCase()), `unapproved color literal: ${color}`);
  }
});

test('lifecycle dialogs are present and retirement is non-destructive', () => {
  for (const id of ['documentChangeDialog', 'documentRetireDialog', 'directoryMaintenanceDialog']) {
    assert.match(html, new RegExp(`id=[\"']${id}[\"']`));
  }
  assert.match(html, /受控退役/);
  assert.match(html, /不会删除飞书原文/);
});

test('directory maintenance previews inheritance impact', () => {
  assert.match(html, /新建目录/);
  assert.match(html, /重命名目录/);
  assert.match(html, /移动目录/);
  assert.match(html, /停用目录/);
  assert.match(html, /权限继承影响/);
});
