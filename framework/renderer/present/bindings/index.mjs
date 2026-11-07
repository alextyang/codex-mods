// The framework's bindings (docs/design/presentations.md V4), one module per presentation type as they land. Each id matches an
// address in ../addresses.json, which framework-main sends the kernel before the first render. NO NODE API.
import { sidebarItem } from './sidebar-item.mjs';
import { stepCommand, stepReasoning, stepTool, stepDelegation, stepEdits, stepFileEdit, stepRow } from './steps.mjs';
import { slashMenu, environmentList } from './slash-menu.mjs';
import { threadHeader } from './thread-header.mjs';
import { requestCard } from './request-card.mjs';
import { turnView } from './turn-view.mjs';
import { userMessage, agentMessage } from './message-block.mjs';
import { threadView } from './thread-view.mjs';
import { sidebarSection, sidebarList } from './sidebar-section.mjs';
import { settingsRow } from './settings-row.mjs';
import { settingsPage } from './settings-page.mjs';
import { composer, composerSuggest, mentionList, composerRunLocation, composerMode, accessMenu, accessRow, accessLegacyRow, branchPicker, branchOptions } from './composer.mjs';
import { fileChip } from './chip.mjs';
import { statusItem } from './status-item.mjs';
import { paletteCommand, paletteChat } from './palette-result.mjs';
import { filesView } from './files-view.mjs';
import { newThreadView, newThreadComposer } from './new-thread-view.mjs';
import { automationForm } from './automation-form.mjs';
import { skillCard, branchRow, branchList } from './list-items.mjs';
import { threadMenu } from './thread-menu.mjs';
import { threadLayout } from './thread-layout.mjs';
import { queueItem, queueRow } from './queue-item.mjs';
import { modelPicker, modelRow } from './composer-picker.mjs';
import { sidebar, sidebarArea, sidebarFooter, sidebarRow, sidebarRowTitle, sidebarRowCard, sectionActions, projectMenu, palette, paletteList, paletteGroup, windowTitleBar, rail, sectionList, pageBanner, titleAction, titleSidebarToggle, frame, footerParts, sidebarGroupsHide, sidebarDivider } from './frame.mjs';
import { sidePanel, sidePanelStrip, panelTab, panelTabBody, terminalBackground, filesPane, filePreview, sidePanelFrame, bottomPanelFrame } from './panel.mjs';
import { terminalView, browserView } from './panel-views.mjs';
import { settingsFrame, automationView, contextMeter, automationSummary, automationEdit, automationMenu } from './settings-attention.mjs';
import { settingsNav, settingsNavGroup } from './settings-nav.mjs';
import { changesView, changesToolbar, changesScope, changesFiles, diffView, diffBody } from './changes.mjs';
import { requestShell, requestSurface } from './request-body.mjs';

export const BINDINGS = Object.freeze([sidebarArea, sidebarItem, threadHeader, requestCard, turnView, userMessage, agentMessage, threadView, sidebarSection, settingsPage, composer, fileChip, statusItem, paletteCommand, filesView, newThreadView, threadMenu, threadLayout, queueItem, modelPicker, sidebar, sidebarFooter, sidebarRow, sidebarRowTitle, sectionActions, palette, sidePanel, sidePanelStrip, panelTab, filesPane, filePreview, terminalView, browserView, settingsFrame, automationView, contextMeter, settingsNav, settingsNavGroup, changesView, changesToolbar, changesScope, changesFiles, diffView, diffBody, requestShell, composerSuggest, mentionList, projectMenu, composerRunLocation, windowTitleBar, rail, newThreadComposer, requestSurface, sectionList, automationSummary, automationEdit, automationMenu, sidePanelFrame, bottomPanelFrame, composerMode, accessMenu, accessRow, accessLegacyRow, branchPicker, branchOptions, pageBanner, sidebarList, settingsRow, titleAction, titleSidebarToggle, frame, stepCommand, stepReasoning, stepTool, stepDelegation, stepEdits, stepFileEdit, stepRow, slashMenu, environmentList, automationForm, paletteChat, sidebarRowCard, skillCard, queueRow, panelTabBody, branchRow, modelRow, terminalBackground, branchList, paletteList, paletteGroup, sidebarGroupsHide, sidebarDivider, ...footerParts]);
