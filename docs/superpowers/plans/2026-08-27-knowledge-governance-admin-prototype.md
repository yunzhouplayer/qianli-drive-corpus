# Knowledge Governance Admin Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing three-view static HTML prototype into a complete knowledge lifecycle and Feishu-permission governance demonstration without performing real Feishu writes.

**Architecture:** Keep the deliverable as one self-contained interactive HTML page plus the official Qianli logo asset. Add lifecycle and permission-management interactions to the existing catalog view, use deterministic in-browser mock state for approvals and execution, and validate structure with Node built-in tests plus browser-rendered design QA.

**Tech Stack:** HTML5, CSS, browser JavaScript, Phosphor Icons CDN, Node.js built-in test runner, Codex in-app Browser.

**Spec:** `docs/superpowers/specs/2026-08-27-feishu-permission-control-integration-design.md`

## Global Constraints

- Keep `operating_mode=governance_validation`; do not enable production indexing.
- Feishu remains authoritative for document body, version, directory position, and actual ACL.
- The prototype must not call Feishu APIs, store credentials, or contain real tokens or complete ACL member lists.
- Permission changes default to the logged-in user's Feishu OAuth identity; application identity is limited to reading, orchestration, callbacks, and controlled background work.
- Routine permission operations may auto-execute after approval; high-risk operations require administrator reconfirmation.
- Permission tightening is fail-closed: MCP access is paused before execution and remains denied until verification and derivative-state handling succeed.
- Use the official asset `prototype-assets/qianli-logo.png` and the Qianli light palette: `#DB0052`, black, white, `#F2F2F2`, `#BFBFBF`, `#7F7F7F`, and `#404040`.
- Do not introduce blue, green, orange, teal, cyan, or purple into the prototype.
- Keep the main deliverable at `knowledge-governance-admin-prototype.html`.

---

### Task 1: Add a structural smoke-test harness and lifecycle navigation

**Files:**
- Create: `tests/knowledge-governance-admin-prototype.test.mjs`
- Modify: `knowledge-governance-admin-prototype.html`

**Interfaces:**
- Consumes: the existing screen IDs `dashboard`, `wizard`, and `catalog`.
- Produces: lifecycle action IDs `createDocument`, `changeDocument`, `retireDocument`, and `maintainDirectory`; catalog detail tab buttons with `data-detail-tab` values `overview`, `permissions`, `changes`, and `audit`.

- [ ] **Step 1: Write the failing structural tests**

```js
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
```

- [ ] **Step 2: Run the tests and verify the new assertions fail**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: the three-view test passes; lifecycle action and detail-tab tests fail because the new IDs and attributes are absent.

- [ ] **Step 3: Add lifecycle controls and inspector tabs**

Add a compact catalog toolbar above the document table:

```html
<div class="lifecycle-actions" aria-label="文档生命周期操作">
  <button id="createDocument" class="primary-btn"><i class="ph ph-plus"></i>新增</button>
  <button id="changeDocument" class="secondary-btn">变更</button>
  <button id="retireDocument" class="secondary-btn danger-outline">退役</button>
  <button id="maintainDirectory" class="secondary-btn">目录维护</button>
</div>
```

Add a four-tab strip below the selected document title:

```html
<div class="detail-tabs" role="tablist" aria-label="文档治理详情">
  <button class="detail-tab active" data-detail-tab="overview">治理概览</button>
  <button class="detail-tab" data-detail-tab="permissions">飞书权限</button>
  <button class="detail-tab" data-detail-tab="changes">变更记录</button>
  <button class="detail-tab" data-detail-tab="audit">审计轨迹</button>
</div>
```

Use Qianli red only for the active tab and the primary action. Keep the toolbar height at 52 pixels and preserve the existing three-pane proportions at a 1440 × 1024 viewport.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: all three tests pass.

- [ ] **Step 5: Commit the navigation increment**

```bash
git add knowledge-governance-admin-prototype.html tests/knowledge-governance-admin-prototype.test.mjs prototype-assets/qianli-logo.png
git commit -m "feat: add knowledge lifecycle prototype navigation"
```

---

### Task 2: Implement document CRUD and directory-maintenance prototype flows

**Files:**
- Modify: `knowledge-governance-admin-prototype.html`
- Modify: `tests/knowledge-governance-admin-prototype.test.mjs`

**Interfaces:**
- Consumes: Task 1 lifecycle action IDs.
- Produces: dialogs `documentChangeDialog`, `documentRetireDialog`, and `directoryMaintenanceDialog`; function `openPrototypeDialog(dialogId: string): void`; function `closePrototypeDialog(dialog: HTMLDialogElement): void`.

- [ ] **Step 1: Add failing tests for lifecycle dialogs and safety copy**

```js
test('lifecycle dialogs are present and retirement is non-destructive', () => {
  for (const id of ['documentChangeDialog', 'documentRetireDialog', 'directoryMaintenanceDialog']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
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
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: the new tests fail because the dialogs and safety copy are absent.

- [ ] **Step 3: Implement the document-change and retirement dialogs**

`documentChangeDialog` must offer three mutually exclusive change types:

```html
<label><input type="radio" name="changeType" value="source_revision" checked>飞书正文版本变化</label>
<label><input type="radio" name="changeType" value="metadata">治理元数据变更</label>
<label><input type="radio" name="changeType" value="directory_move">目录位置变更</label>
```

Its impact preview must list source version revalidation, approval staleness, raw cache invalidation, LLM Wiki recompilation, and MCP availability.

`documentRetireDialog` must use the term “受控退役”, require a reason and effective time, and show this exact boundary:

```html
<p class="safety-copy">退役将停止准入状态、快照、索引与 MCP 使用，不会删除飞书原文；飞书原文删除需在其权威来源中另行确认。</p>
```

- [ ] **Step 4: Implement the directory-maintenance dialog**

Provide operations `新建目录`, `重命名目录`, `移动目录`, and `停用目录`. The preview must display affected document count, inherited permission domain, pending admissions, compiled generations, and MCP sources. Disable the confirm button until the operator checks “我已确认权限继承影响”.

- [ ] **Step 5: Wire lifecycle actions**

```js
function openPrototypeDialog(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

function closePrototypeDialog(dialog) {
  if (dialog instanceof HTMLDialogElement) dialog.close();
}

document.getElementById('createDocument').addEventListener('click', () => showScreen('wizard'));
document.getElementById('changeDocument').addEventListener('click', () => openPrototypeDialog('documentChangeDialog'));
document.getElementById('retireDocument').addEventListener('click', () => openPrototypeDialog('documentRetireDialog'));
document.getElementById('maintainDirectory').addEventListener('click', () => openPrototypeDialog('directoryMaintenanceDialog'));
```

Submitting any dialog must update only local mock state and show a toast containing “原型演示”; it must not call `fetch`, `XMLHttpRequest`, WebSocket, or a form action URL.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: all lifecycle tests pass.

- [ ] **Step 7: Commit the lifecycle flows**

```bash
git add knowledge-governance-admin-prototype.html tests/knowledge-governance-admin-prototype.test.mjs
git commit -m "feat: prototype document and directory lifecycle flows"
```

---

### Task 3: Add the Feishu permission view and change-request workflow

**Files:**
- Modify: `knowledge-governance-admin-prototype.html`
- Modify: `tests/knowledge-governance-admin-prototype.test.mjs`

**Interfaces:**
- Consumes: Task 1 detail-tab buttons and the selected catalog row.
- Produces: panel `permissionPanel`, button `requestPermissionChange`, drawer `permissionChangeDrawer`, function `classifyPermissionRisk(change): 'low' | 'medium' | 'high' | 'blocked'`, and function `renderPermissionImpact(change): void`. The `change` object contains boolean fields `removesLastAdmin`, `inheritanceUnknown`, `policyBlocked`, `external`, `publicLink`, `ownerTransfer`, `spaceAdmin`, and `secureLabel`, plus string fields `permission`, `action`, and `subjectType`.

- [ ] **Step 1: Add failing permission-workflow tests**

```js
test('permission view preserves Feishu authority and inheritance', () => {
  assert.match(html, /id=["']permissionPanel["']/);
  assert.match(html, /访问权限以飞书实时 ACL 为准/);
  assert.match(html, /直接授权/);
  assert.match(html, /继承自父目录/);
  assert.match(html, /最近校验时间/);
});

test('permission change flow includes approval, execution, and read-back states', () => {
  assert.match(html, /id=["']permissionChangeDrawer["']/);
  for (const label of ['规则预检', '飞书审批', '执行权限变更', '回读飞书 ACL', '派生数据处理']) {
    assert.match(html, new RegExp(label));
  }
});

test('prototype contains no real write transport', () => {
  assert.doesNotMatch(html, /fetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /new\s+WebSocket/);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: permission view and workflow tests fail; the transport safety test passes.

- [ ] **Step 3: Implement the read-through permission panel**

The panel must show anonymized rows only:

```js
const permissionMembers = [
  { subject: '产品与技术管理中心', type: '部门', permission: '可阅读', grant: '继承自知识空间', expiry: '长期有效' },
  { subject: '测试平台组', type: '群组', permission: '可编辑', grant: '继承自父目录', expiry: '长期有效' },
  { subject: '文档负责人', type: '角色', permission: '可管理', grant: '直接授权', expiry: '长期有效' },
];
```

Show `最近校验时间：2026-08-27 14:20` and the statement `访问权限以飞书实时 ACL 为准`. Do not show actual member IDs, email addresses, tokens, or a complete production ACL.

- [ ] **Step 4: Implement the permission-change drawer**

The drawer must collect subject type, anonymized subject, requested permission, effective/expiry time, reason, and approval route. It must show a before/after diff and inherited source. If the selected permission is inherited, disable direct document-level editing and show a button that changes context to the source directory.

Render these five workflow stages in order:

```js
const permissionStages = [
  '规则预检',
  '飞书审批',
  '执行权限变更',
  '回读飞书 ACL',
  '派生数据处理',
];
```

- [ ] **Step 5: Implement deterministic risk classification**

```js
function classifyPermissionRisk(change) {
  if (change.removesLastAdmin || change.inheritanceUnknown || change.policyBlocked) return 'blocked';
  if (change.external || change.publicLink || change.ownerTransfer || change.spaceAdmin || change.secureLabel) return 'high';
  if (change.permission === 'edit' || change.action === 'revoke' || change.subjectType === 'group') return 'medium';
  return 'low';
}
```

Render the risk result and AI impact with this deterministic helper:

```js
function renderPermissionImpact(change) {
  const risk = classifyPermissionRisk(change);
  const treatment = {
    low: '审批通过后自动执行',
    medium: '审批通过后自动执行',
    high: '审批通过后需管理员二次确认',
    blocked: '必须在飞书原生权限页处理',
  }[risk];
  document.querySelector('[data-permission-risk]').textContent = risk;
  document.querySelector('[data-permission-treatment]').textContent = treatment;
  document.querySelector('[data-permission-submit]').disabled = risk === 'blocked';
}
```

Low and medium risk results display `审批通过后自动执行`. High risk displays `审批通过后需管理员二次确认`. Blocked results disable submission and display `必须在飞书原生权限页处理`.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: all permission tests pass and the transport safety test still passes.

- [ ] **Step 7: Commit the permission workflow**

```bash
git add knowledge-governance-admin-prototype.html tests/knowledge-governance-admin-prototype.test.mjs
git commit -m "feat: prototype Feishu permission governance workflow"
```

---

### Task 4: Model approval, execution, verification, and derivative-state failures

**Files:**
- Modify: `knowledge-governance-admin-prototype.html`
- Modify: `tests/knowledge-governance-admin-prototype.test.mjs`

**Interfaces:**
- Consumes: Task 3 permission stages and risk classification.
- Produces: function `transitionPermissionRequest(nextState): void`, where `nextState` is one of `draft`, `prechecking`, `approving`, `awaiting_execution`, `executing`, `verifying`, `propagating`, `completed`, `stale`, `reauth_required`, `blocked_by_feishu_policy`, `verification_failed`, and `propagation_failed`.

- [ ] **Step 1: Add failing state-coverage tests**

```js
test('permission request exposes approved and failure states', () => {
  for (const state of [
    'draft', 'prechecking', 'approving', 'awaiting_execution', 'executing',
    'verifying', 'propagating', 'completed', 'stale', 'reauth_required',
    'blocked_by_feishu_policy', 'verification_failed', 'propagation_failed'
  ]) {
    assert.match(html, new RegExp(`['"]${state}['"]`));
  }
});

test('permission tightening is visibly fail-closed', () => {
  assert.match(html, /先暂停 MCP 访问/);
  assert.match(html, /完成回读和派生数据校验后恢复/);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: failure-state and fail-closed copy assertions fail.

- [ ] **Step 3: Implement the in-browser state model**

Store the current request in one local object:

```js
const permissionRequest = {
  id: 'PCR-20260827-0001',
  state: 'draft',
  risk: 'medium',
  action: 'revoke',
  target: '测试平台组',
  mcpState: 'active',
};

const permissionRequestStates = new Set([
  'draft', 'prechecking', 'approving', 'awaiting_execution', 'executing',
  'verifying', 'propagating', 'completed', 'stale', 'reauth_required',
  'blocked_by_feishu_policy', 'verification_failed', 'propagation_failed',
]);

function transitionPermissionRequest(nextState) {
  if (!permissionRequestStates.has(nextState)) throw new Error(`Unsupported permission state: ${nextState}`);
  permissionRequest.state = nextState;
  document.querySelector('[data-permission-request-state]').textContent = nextState;
  document.querySelector('[data-mcp-state]').textContent = permissionRequest.mcpState;
}
```

For revoke or permission downgrade, set `mcpState='denied_pending_verification'` before entering `executing`. For permission expansion, keep MCP unavailable until `completed`.

- [ ] **Step 4: Add deterministic simulation controls**

Add a prototype-only scenario selector with `成功`, `审批期间 ACL 变化`, `OAuth 失效`, `飞书策略阻止`, `回读不一致`, and `派生数据失败`. Each selection must drive the appropriate terminal or retry state without network calls.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit state behavior**

```bash
git add knowledge-governance-admin-prototype.html tests/knowledge-governance-admin-prototype.test.mjs
git commit -m "feat: model permission execution and failure states"
```

---

### Task 5: Run browser verification and design QA

**Files:**
- Create: `design-qa.md`
- Create: `output/prototype-qa/dashboard.png`
- Create: `output/prototype-qa/admission.png`
- Create: `output/prototype-qa/catalog-overview.png`
- Create: `output/prototype-qa/catalog-permissions.png`
- Create: `output/prototype-qa/permission-change.png`
- Modify: `knowledge-governance-admin-prototype.html` only when QA finds P0, P1, or P2 issues.

**Interfaces:**
- Consumes: the three source visual images and the completed local prototype.
- Produces: browser-tested HTML and `design-qa.md` with exact `final result: passed` or `final result: blocked`.

- [ ] **Step 1: Run structural tests**

Run: `node --test tests/knowledge-governance-admin-prototype.test.mjs`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Start the local static server**

Run: `python3 -m http.server 8766`

Expected: the server reports that it is listening on port `8766` from the repository root.

- [ ] **Step 3: Open the prototype in the Codex in-app Browser**

Open: `http://127.0.0.1:8766/knowledge-governance-admin-prototype.html`

Use a 1440 × 1024 viewport. Verify the browser console has no JavaScript errors and the official logo loads successfully.

- [ ] **Step 4: Test primary interactions**

Verify all of the following:

1. The three top-level views switch without reloading.
2. Admission form required-field validation blocks an incomplete submission.
3. Catalog search filters rows and row selection updates the inspector.
4. New document routes to the admission wizard.
5. Change, retirement, and directory-maintenance dialogs open and close.
6. Retirement copy states that the Feishu source is not deleted.
7. Permission tabs switch and display current ACL authority and inheritance.
8. Low/medium/high/blocked permission scenarios render the correct execution treatment.
9. Revoke simulation pauses MCP before mock execution.
10. Successful permission simulation reaches completed only after read-back and derivative handling.

- [ ] **Step 5: Capture implementation evidence**

Capture the five listed PNG files at the same 1440 × 1024 viewport. Capture `permission-change.png` with the permission drawer open and the medium-risk revoke scenario selected.

- [ ] **Step 6: Compare against all three source visuals**

Source visual truth paths:

```text
/Users/langwen/.codex/generated_images/01a040eb-6855-7030-b5c5-029cb1c96f82/exec-7271a13d-c32c-4853-9b2f-101d3bfe45cd.png
/Users/langwen/.codex/generated_images/01a040eb-6855-7030-b5c5-029cb1c96f82/exec-d8856b74-4842-4bf3-9c46-d213f9412c58.png
/Users/langwen/.codex/generated_images/01a040eb-6855-7030-b5c5-029cb1c96f82/exec-decef57a-d69a-4358-851d-6e5a5169555a.png
```

Place each source and corresponding implementation capture in the same comparison input. Check typography, spacing, Qianli palette, logo quality, copy, table density, dialog hierarchy, active states, overflow, and permission-flow clarity.

- [ ] **Step 7: Fix P0, P1, and P2 findings and repeat capture**

Apply only evidence-backed fixes. Re-run interaction checks and recapture affected states at 1440 × 1024 until no P0, P1, or P2 finding remains.

- [ ] **Step 8: Write the QA report**

Create `design-qa.md` with source paths, implementation screenshot paths, viewport, pixel dimensions, density, interaction results, console result, comparison history, remaining P3 notes, and the exact terminal line:

```text
final result: passed
```

If browser-rendered evidence cannot be captured, write `final result: blocked` and name the blocker instead of claiming completion.

- [ ] **Step 9: Commit the verified prototype**

```bash
git add knowledge-governance-admin-prototype.html prototype-assets/qianli-logo.png tests/knowledge-governance-admin-prototype.test.mjs design-qa.md output/prototype-qa
git commit -m "feat: deliver knowledge governance admin prototype"
```
