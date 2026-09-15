import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("the approved roundtable layout has one task input and advanced settings stay in a drawer", async () => {
  const [html, app, css, threadStatusModel, commandModel, disclosureController, scrollController] = await Promise.all([
    fs.readFile(new URL("./index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("./app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("./styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("./thread-status-model.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("./roundtable-command-model.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("./progress-disclosure-controller.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("./conversation-scroll-controller.mjs", import.meta.url), "utf8"),
  ]);

  assert.equal((html.match(/<textarea\b/g) || []).length, 1);
  assert.match(html, /id="workspaceButton"/);
  assert.match(html, /id="sessionSelectTop"/);
  assert.match(html, /id="settingsDialog" class="settings-drawer"/);
  assert.match(html, /id="workbenchEnabled"/);
  assert.match(html, /id="permissionDialog"/);
  assert.match(html, /id="recoveryDialog"/);
  assert.match(html, /id="pendingInterventionQueue"/);
  assert.match(html, /id="roleDialog"/);
  assert.match(html, /最多周期/);
  assert.match(html, /id="handoffDialog"/);
  assert.match(html, /data-tab="context"/);
  assert.match(html, /id="contextUsage"/);
  assert.match(html, /id="compressionRevision"/);
  assert.match(html, /id="compressionCoverage"/);
  assert.match(html, /id="compressedContextView"/);
  assert.match(html, /id="recentRawContextView"/);
  assert.match(html, /id="compressionEditDialog"/);
  assert.match(html, /id="collapseDetailSidebarButton"/);
  assert.match(html, /id="restoreDetailSidebarButton"/);
  assert.match(html, /id="workspaceDivider"/);
  assert.match(html, /id="scrollConversationBottomButton"/);
  assert.match(html, /aria-label="滚动到最新消息"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /src="\/vendor\/marked\.umd\.js"/);
  assert.match(html, /src="\/vendor\/purify\.min\.js"/);
  assert.equal((html.match(/data-task-input="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /当前任务|数据根目录/);
  assert.match(app, /getComposerSuggestions/);
  assert.match(app, /workbenchEnabled/);
  assert.match(app, /findSnappedHost/);
  assert.match(app, /resolveRunRecovery/);
  assert.match(app, /previousSessionId !== state\.session\.id/);
  assert.doesNotMatch(app, /if \(!state\.tokens\.length\)/);
  assert.match(css, /node-to-node|\.seat-node/);
  assert.match(css, /--pink:\s*#d[0-9a-f]{5}/i);
  assert.match(css, /--canvas:\s*#fff[0-9a-f]{3,4}/i);
  assert.match(css, /\.roundtable-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(/s);
  assert.match(css, /\.conversation-pane\s*\{[^}]*grid-column:\s*3/s);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.conversation-pane\s*\{[^}]*height:\s*min\(62vh, 560px\)/);
  assert.match(css, /\.composer-pane\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(app, /data-action="reconnect"/);
  assert.match(app, /重新登录\/刷新/);
  assert.match(app, /web-agents-roundtable:last-session/);
  assert.match(app, /createDetailSidebarController/);
  assert.match(app, /createWorkspaceSplitController/);
  assert.match(app, /createConversationScrollController/);
  assert.match(app, /renderSafeMarkdown/);
  assert.match(app, /hardenRenderedLinks/);
  assert.match(app, /resolveThreadStatus/);
  assert.match(app, /resolveRoundtableCommand/);
  assert.match(app, /roundtableObjective.*title/s);
  assert.match(app, /state\.health\?\.browser\?\.bindings/);
  assert.match(threadStatusModel, /需要重新连接/);
  assert.match(css, /workspace-layout\.is-detail-collapsed/);
  assert.match(css, /grid-template-columns:[^;}]*0/);
  assert.match(css, /\.roundtable-workspace\s*\{[^}]*grid-template-columns:[^}]*8px/s);
  assert.match(css, /\.workspace-divider\s*\{/);
  assert.match(css, /\.markdown-body p \{ margin: \.35em 0; \}/);
  assert.match(css, /\.progress-stream \{[^}]*max-height: 220px[^}]*overflow: auto/s);
  assert.match(app, /progress-disclosure/);
  assert.match(app, /captureProgressView/);
  assert.match(app, /data-reply-event-id/);
  assert.match(app, /turn\.passed/);
  assert.match(app, /cycle\.started/);
  assert.match(app, /cycle\.completed/);
  assert.match(app, /intervention\.queued/);
  assert.match(app, /本周期旁听/);
  assert.match(commandModel, /resolveRoundtableCommand/);
  assert.match(disclosureController, /captureProgressView/);
  assert.match(disclosureController, /restoreProgressView/);
  assert.match(scrollController, /preserveScroll/);
  assert.match(scrollController, /generating/);
  assert.match(app, /waiting_recovery/);
  assert.match(app, /state\.activeRun\?\.status \|\| state\.session\?\.runtime\?\.status/);
  assert.doesNotMatch(app, /nearBottom/);
  assert.match(css, /\.chat-event\s*\{[^}]*display:\s*block/s);
  assert.match(css, /\.conversation-scroll-bottom\s*\{/);
  assert.match(css, /overflow-anchor:\s*none/);
  assert.match(css, /\.event-meta\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.event-content\s*\{[^}]*width:\s*100%/s);
  assert.doesNotMatch(css, /grid-template-columns:\s*92px\s+minmax\(0,\s*1fr\)/);
  assert.match(app, /preserveSessionId/);
  assert.doesNotMatch(app, /structuredReply|structureStatus|查看原始回复|reply-raw/);
  assert.doesNotMatch(css, /\.reply-raw/);
  assert.match(threadStatusModel, /输入框未找到/);
  assert.match(html, /id="seatSpokes"/);
  assert.match(app, /avatarMarkup/);
  assert.match(app, /assets\/avatars/);
  assert.match(css, /\.seat-avatar/);
  assert.match(css, /\.seat-spokes line/);
  assert.match(html, /优先复用已有模型标签页并进入新对话/);
  assert.doesNotMatch(html, /每个入席模型都会在项目专用 Chrome 中获得新的网页会话/);
});
