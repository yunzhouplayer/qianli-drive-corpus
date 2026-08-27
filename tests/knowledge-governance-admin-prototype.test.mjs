import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../knowledge-governance-admin-prototype.html', import.meta.url), 'utf8');

function createBrowserFreePrototype() {
  class FakeElement {
    constructor() {
      this.listeners = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.style = {};
      this.dataset = {};
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.textContent = '';
      this.formData = {};
    }

    addEventListener(type, handler) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
    }

    dispatch(type) {
      let prevented = false;
      const event = { currentTarget: this, preventDefault: () => { prevented = true; } };
      for (const handler of this.listeners.get(type) ?? []) handler(event);
      return { prevented };
    }

    closest(selector) {
      return selector === 'dialog' ? this.dialog : null;
    }

    querySelector() {
      return new FakeElement();
    }

    reportValidity() {
      return true;
    }
  }

  class FakeDialog extends FakeElement {
    showModal() { this.showModalCalls = (this.showModalCalls ?? 0) + 1; }
    close() { this.closeCalls = (this.closeCalls ?? 0) + 1; this.dispatch('close'); }
  }

  class FakeFormData {
    constructor(form) { this.form = form; }
    get(name) { return this.form.formData[name] ?? null; }
  }

  const ids = ['toast', 'reviewNext', 'saveDraft', 'admissionForm', 'inspectorTitle', 'revisionAlert', 'admissionState', 'sourceVersion', 'cacheVersion', 'catalogSearch', 'filterButton', 'createDocument', 'changeDocument', 'retireDocument', 'maintainDirectory', 'documentChangeForm', 'documentRetireForm', 'retireReason', 'retireEffectiveAt', 'directoryImpactConfirmed', 'directoryMaintenanceConfirm', 'directoryMaintenanceForm', 'openSource', 'revalidate', 'requestPermissionChange', 'permissionChangeForm', 'permissionSubjectType', 'permissionAction', 'permissionRequested', 'permissionExternal', 'permissionPublicLink', 'permissionOwnerTransfer', 'permissionSpaceAdmin', 'permissionSecureLabel', 'permissionPolicyBlocked', 'permissionInheritanceUnknown', 'permissionRemovesLastAdmin', 'permissionSourceContext', 'permissionAfterDiff', 'permissionImpactCopy'];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  for (const id of ['documentChangeDialog', 'documentRetireDialog', 'directoryMaintenanceDialog', 'permissionChangeDrawer']) elements[id] = new FakeDialog();
  elements.documentChangeForm.dialog = elements.documentChangeDialog;
  elements.documentRetireForm.dialog = elements.documentRetireDialog;
  elements.directoryMaintenanceForm.dialog = elements.directoryMaintenanceDialog;
  elements.permissionChangeForm.dialog = elements.permissionChangeDrawer;
  elements.documentChangeForm.formData.changeType = 'source_revision';
  elements.directoryMaintenanceForm.formData.directoryOperation = 'create';

  const window = { location: { hash: '' } };
  const document = {
    getElementById(id) { return elements[id]; },
    querySelector() { return new FakeElement(); },
    querySelectorAll() { return []; },
  };
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'prototype script must be present');
  vm.runInNewContext(script, { document, window, HTMLDialogElement: FakeDialog, FormData: FakeFormData, clearTimeout() {}, setTimeout() { return 1; } });
  return { elements, window };
}

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

test('lifecycle actions are wired to the wizard and their local dialogs', () => {
  assert.match(html, /getElementById\('createDocument'\)\.addEventListener\('click', \(\) => showScreen\('wizard'\)\)/);
  assert.match(html, /getElementById\('changeDocument'\)\.addEventListener\('click', \(\) => openPrototypeDialog\('documentChangeDialog'\)\)/);
  assert.match(html, /getElementById\('retireDocument'\)\.addEventListener\('click', \(\) => openPrototypeDialog\('documentRetireDialog'\)\)/);
  assert.match(html, /getElementById\('maintainDirectory'\)\.addEventListener\('click', \(\) => openPrototypeDialog\('directoryMaintenanceDialog'\)\)/);
});

test('lifecycle dialog submits are local-only and notify the operator', () => {
  assert.match(html, /const localPrototypeState = \{ lifecycleEvents: \[\] \}/);
  assert.match(html, /localPrototypeState\.lifecycleEvents\.push/g);
  assert.match(html, /原型演示/);
  assert.doesNotMatch(html, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|<form[^>]+\baction=/i);
});

test('directory maintenance resets permission acknowledgement whenever its dialog opens or closes', () => {
  assert.match(html, /function resetDirectoryMaintenanceConfirmation\(\)\s*\{[\s\S]*directoryImpactConfirmed\.checked = false;[\s\S]*directoryMaintenanceConfirm\.disabled = true;/);
  assert.match(html, /if \(dialogId === 'directoryMaintenanceDialog'\) resetDirectoryMaintenanceConfirmation\(\);/);
  assert.match(html, /directoryMaintenanceDialog\.addEventListener\('close', resetDirectoryMaintenanceConfirmation\)/);
  assert.match(html, /directoryMaintenanceConfirm\.disabled = !directoryImpactConfirmed\.checked;/);
});

test('permission view preserves Feishu authority and inheritance', () => {
  assert.match(html, /id=["']permissionPanel["']/);
  assert.match(html, /访问权限以飞书实时 ACL 为准/);
  assert.match(html, /直接授权/);
  assert.match(html, /继承自父目录/);
  assert.match(html, /最近校验时间/);
  assert.match(html, /id=["']permissionDocumentLevelEditing["'][^>]*disabled/);
  assert.match(html, /前往父目录授权来源/);
});

test('permission change flow includes approval, execution, and read-back states', () => {
  assert.match(html, /id=["']permissionChangeDrawer["']/);
  for (const label of ['规则预检', '飞书审批', '执行权限变更', '回读飞书 ACL', '派生数据处理']) {
    assert.match(html, new RegExp(label));
  }
});

test('permission risk classifier preserves deterministic governance routing', () => {
  assert.match(html, /function classifyPermissionRisk\(change\)/);
  assert.match(html, /removesLastAdmin \|\| change\.inheritanceUnknown \|\| change\.policyBlocked/);
  assert.match(html, /审批通过后自动执行/);
  assert.match(html, /审批通过后需管理员二次确认/);
  assert.match(html, /必须在飞书原生权限页处理/);
});

test('prototype contains no real write transport', () => {
  assert.doesNotMatch(html, /fetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /new\s+WebSocket/);
});

test('permission change entry opens a local-only drawer and remains browser-transport free', () => {
  const { elements } = createBrowserFreePrototype();
  elements.requestPermissionChange.dispatch('click');
  assert.equal(elements.permissionChangeDrawer.showModalCalls, 1);
  assert.equal(elements.permissionChangeForm.dispatch('submit').prevented, true);
  assert.equal(elements.permissionChangeDrawer.closeCalls, 1);
  assert.match(elements.toast.textContent, /飞书审批与 ACL 回读/);
});

test('browser-free lifecycle interactions open dialogs, retain local-only behavior, and require fresh confirmation', () => {
  const { elements, window } = createBrowserFreePrototype();
  elements.createDocument.dispatch('click');
  assert.equal(window.location.hash, 'wizard');
  elements.changeDocument.dispatch('click');
  elements.retireDocument.dispatch('click');
  elements.maintainDirectory.dispatch('click');
  assert.equal(elements.documentChangeDialog.showModalCalls, 1);
  assert.equal(elements.documentRetireDialog.showModalCalls, 1);
  assert.equal(elements.directoryMaintenanceDialog.showModalCalls, 1);
  assert.equal(elements.directoryImpactConfirmed.checked, false);
  assert.equal(elements.directoryMaintenanceConfirm.disabled, true);

  elements.directoryImpactConfirmed.checked = true;
  elements.directoryImpactConfirmed.dispatch('change');
  assert.equal(elements.directoryMaintenanceConfirm.disabled, false);
  assert.equal(elements.directoryMaintenanceForm.dispatch('submit').prevented, true);
  assert.match(elements.toast.textContent, /原型演示/);
  assert.equal(elements.directoryImpactConfirmed.checked, false);
  assert.equal(elements.directoryMaintenanceConfirm.disabled, true);
});
