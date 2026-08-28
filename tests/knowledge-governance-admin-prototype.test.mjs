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

  const ids = ['toast', 'reviewNext', 'saveDraft', 'admissionForm', 'inspectorTitle', 'revisionAlert', 'admissionState', 'sourceVersion', 'cacheVersion', 'catalogSearch', 'filterButton', 'createDocument', 'changeDocument', 'retireDocument', 'maintainDirectory', 'documentChangeForm', 'documentRetireForm', 'retireReason', 'retireEffectiveAt', 'directoryImpactConfirmed', 'directoryMaintenanceConfirm', 'directoryMaintenanceForm', 'openSource', 'revalidate', 'requestPermissionChange', 'permissionChangeForm', 'permissionSubjectType', 'permissionSubject', 'permissionAction', 'permissionRequested', 'permissionEffectiveAt', 'permissionExpiryAt', 'permissionApprovalRoute', 'permissionReason', 'permissionExternal', 'permissionPublicLink', 'permissionOwnerTransfer', 'permissionSpaceAdmin', 'permissionSecureLabel', 'permissionPolicyBlocked', 'permissionInheritanceUnknown', 'permissionRemovesLastAdmin', 'permissionSourceContext', 'permissionDocumentLevelEditing', 'permissionTargetLabel', 'permissionTargetRef', 'permissionInheritedSource', 'permissionAfterDiff', 'permissionImpactCopy', 'permissionScopeNotice', 'permissionRisk', 'permissionTreatment', 'permissionSubmit'];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  for (const id of ['documentChangeDialog', 'documentRetireDialog', 'directoryMaintenanceDialog', 'permissionChangeDrawer']) elements[id] = new FakeDialog();
  elements.documentChangeForm.dialog = elements.documentChangeDialog;
  elements.documentRetireForm.dialog = elements.documentRetireDialog;
  elements.directoryMaintenanceForm.dialog = elements.directoryMaintenanceDialog;
  elements.permissionChangeForm.dialog = elements.permissionChangeDrawer;
  elements.documentChangeForm.formData.changeType = 'source_revision';
  elements.directoryMaintenanceForm.formData.directoryOperation = 'create';
  elements.permissionSubjectType.value = 'user';
  elements.permissionSubject.value = '测试平台组（示例）';
  elements.permissionAction.value = 'grant';
  elements.permissionRequested.value = 'read';
  elements.permissionEffectiveAt.value = '2026-08-27T15:00';
  elements.permissionExpiryAt.value = '2026-09-27T15:00';
  elements.permissionApprovalRoute.value = '知识空间管理员审批';
  elements.permissionReason.value = '无敏感测试用途';

  const catalogRows = [new FakeElement(), new FakeElement(), new FakeElement()];
  catalogRows[0].dataset = { title: '测试功能点提取准出标准', owner: '张伟', version: 'v3.2', state: '需重新校验', resourceRef: 'wiki-node:governance-validation-vv-001', permissionSource: '02-测试与质量 / Validation & Verification', permissionSourceRef: 'wiki-directory:validation-quality' };
  catalogRows[1].dataset = { title: '测试用例设计规范', owner: '王五', version: 'v4.1', state: '已通过', resourceRef: 'wiki-node:governance-validation-testcase-002', permissionSource: '02-测试与质量 / Validation & Verification', permissionSourceRef: 'wiki-directory:validation-quality' };
  catalogRows[2].dataset = { title: '缺少权限元数据的测试夹具', owner: '系统', version: 'v0.0', state: '待补全' };

  const window = { location: { hash: '' } };
  const document = {
    getElementById(id) { return elements[id]; },
    querySelector(selector) {
      if (selector === '[data-permission-risk]') return elements.permissionRisk;
      if (selector === '[data-permission-treatment]') return elements.permissionTreatment;
      if (selector === '[data-permission-submit]') return elements.permissionSubmit;
      return new FakeElement();
    },
    querySelectorAll(selector) { return selector === '#catalogRows tr' ? catalogRows : []; },
  };
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'prototype script must be present');
  const sandbox = { document, window, HTMLDialogElement: FakeDialog, FormData: FakeFormData, clearTimeout() {}, setTimeout() { return 1; } };
  vm.runInNewContext(script, sandbox);
  return { catalogRows, elements, sandbox, window };
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
  assert.match(html, /const localPrototypeState = \{ lifecycleEvents: \[\], permissionChangeEvents: \[\] \}/);
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

test('every actionable catalog row carries a complete anonymized permission target fixture', () => {
  const catalogMarkup = html.match(/<tbody id="catalogRows">([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  const rows = catalogMarkup.match(/<tr\b[^>]*>/g) ?? [];
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.match(row, /data-resource-ref="wiki-node:governance-validation-[^"]+"/);
    assert.match(row, /data-permission-source="[^"]+"/);
    assert.match(row, /data-permission-source-ref="wiki-directory:[^"]+"/);
  }
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

test('permission risk routing and render treatment are deterministic with blocked precedence', () => {
  const { elements, sandbox } = createBrowserFreePrototype();
  const classify = sandbox.classifyPermissionRisk;
  const render = sandbox.renderPermissionImpact;
  elements.permissionSourceContext.dispatch('click');
  assert.equal(classify({ permission: 'read', action: 'grant', subjectType: 'user' }), 'low');
  assert.equal(classify({ permission: 'edit', action: 'grant', subjectType: 'user' }), 'medium');
  assert.equal(classify({ external: true, permission: 'read', action: 'grant', subjectType: 'user' }), 'high');
  assert.equal(classify({ external: true, inheritanceUnknown: true, permission: 'read', action: 'grant', subjectType: 'user' }), 'blocked');

  render({ permission: 'read', action: 'grant', subjectType: 'user' });
  assert.equal(elements.permissionRisk.textContent, 'low');
  assert.equal(elements.permissionTreatment.textContent, '审批通过后自动执行');
  assert.equal(elements.permissionSubmit.disabled, false);

  render({ external: true, permission: 'read', action: 'grant', subjectType: 'user' });
  assert.equal(elements.permissionRisk.textContent, 'high');
  assert.equal(elements.permissionTreatment.textContent, '审批通过后需管理员二次确认');
  assert.equal(elements.permissionSubmit.disabled, false);

  render({ policyBlocked: true, permission: 'read', action: 'grant', subjectType: 'user' });
  assert.equal(elements.permissionRisk.textContent, 'blocked');
  assert.equal(elements.permissionTreatment.textContent, '必须在飞书原生权限页处理');
  assert.equal(elements.permissionSubmit.disabled, true);
});

test('prototype contains no real write transport', () => {
  assert.doesNotMatch(html, /fetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /new\s+WebSocket/);
});

test('permission requests bind to the selected catalog target and guard inherited document-level changes', () => {
  const { catalogRows, elements, window } = createBrowserFreePrototype();
  catalogRows[1].dispatch('click');
  elements.requestPermissionChange.dispatch('click');
  assert.equal(elements.permissionChangeDrawer.showModalCalls, 1);
  assert.equal(elements.permissionTargetLabel.textContent, '测试用例设计规范');
  assert.equal(elements.permissionTargetRef.textContent, 'wiki-node:governance-validation-testcase-002');
  assert.equal(elements.permissionAction.disabled, true);
  assert.equal(elements.permissionRequested.disabled, true);
  assert.equal(elements.permissionSubmit.disabled, true);
  assert.equal(elements.permissionChangeForm.dispatch('submit').prevented, true);
  assert.equal(window.knowledgeGovernancePrototypeState.permissionChangeEvents.length, 0);
  assert.match(elements.toast.textContent, /继承自父目录/);

  elements.permissionSourceContext.dispatch('click');
  assert.equal(elements.permissionTargetLabel.textContent, '02-测试与质量 / Validation & Verification');
  assert.equal(elements.permissionTargetRef.textContent, 'wiki-directory:validation-quality');
  assert.equal(elements.permissionAction.disabled, false);
  assert.equal(elements.permissionRequested.disabled, false);
  assert.equal(elements.permissionDocumentLevelEditing.disabled, true);
  assert.equal(elements.permissionSubmit.disabled, false);
  assert.equal(elements.permissionChangeForm.dispatch('submit').prevented, true);
  assert.equal(window.knowledgeGovernancePrototypeState.permissionChangeEvents.length, 1);
  assert.deepEqual({ ...window.knowledgeGovernancePrototypeState.permissionChangeEvents[0] }, {
    type: 'permission-change-request',
    removesLastAdmin: false,
    inheritanceUnknown: false,
    policyBlocked: false,
    external: false,
    publicLink: false,
    ownerTransfer: false,
    spaceAdmin: false,
    secureLabel: false,
    targetLabel: '02-测试与质量 / Validation & Verification',
    targetRef: 'wiki-directory:validation-quality',
    subjectType: 'user',
    subject: '测试平台组（示例）',
    action: 'grant',
    permission: 'read',
    effectiveAt: '2026-08-27T15:00',
    expiryAt: '2026-09-27T15:00',
    reason: '无敏感测试用途',
    approvalRoute: '知识空间管理员审批',
    inheritedSource: '02-测试与质量 / Validation & Verification',
    context: 'source-directory',
    risk: 'low',
  });
  assert.equal(elements.permissionChangeDrawer.closeCalls, 1);
});

test('permission request fails closed when a future catalog row lacks required permission metadata', () => {
  const { catalogRows, elements, sandbox, window } = createBrowserFreePrototype();
  catalogRows[2].dispatch('click');
  assert.equal(elements.requestPermissionChange.disabled, true);
  elements.requestPermissionChange.dispatch('click');
  assert.equal(elements.permissionChangeDrawer.showModalCalls, undefined);
  assert.equal(elements.permissionTargetLabel.textContent, '权限目标信息不完整');
  elements.permissionSourceContext.dispatch('click');
  assert.equal(elements.permissionTargetLabel.textContent, '权限目标信息不完整');
  assert.equal(elements.permissionTargetRef.textContent, '缺少稳定资源引用');
  assert.equal(sandbox.readPermissionChange().context, 'document');
  assert.match(elements.toast.textContent, /不能切换授权来源/);
  assert.equal(elements.permissionChangeForm.dispatch('submit').prevented, true);
  assert.equal(window.knowledgeGovernancePrototypeState.permissionChangeEvents.length, 0);
  assert.match(elements.toast.textContent, /缺少稳定资源引用或权限来源/);
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
