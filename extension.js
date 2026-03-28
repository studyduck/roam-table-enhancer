(() => {
  'use strict';

  const PLUGIN_KEY = '__roamBuiltinEditableTablePlugin';
  const STYLE_ID = 'roam-builtin-editable-table-style';
  const CELL_ATTR = 'data-bet-cell';
  const CELL_UID_ATTR = 'data-bet-cell-uid';
  const ROW_INDEX_ATTR = 'data-bet-row-index';
  const COL_INDEX_ATTR = 'data-bet-col-index';
  const ADDED_TABINDEX_ATTR = 'data-bet-added-tabindex';
  const EDITABLE_CLASS = 'roam-builtin-table-editable';
  const SELECTED_CLASS = 'is-selected';
  const EDITING_CLASS = 'is-editing';
  const INPUT_CLASS = 'roam-builtin-table-input';
  const CONTEXT_MENU_CLASS = 'roam-builtin-table-context-menu';
  const CONTEXT_MENU_ITEM_CLASS = 'roam-builtin-table-context-menu-item';
  const CONTEXT_MENU_ACTION_ATTR = 'data-bet-menu-action';
  const TABLE_MARKERS = new Set(['{{table}}', '{{[[table]]}}']);
  const DISABLED_RETRY_MS = 3000;
  const MAX_NATIVE_TABLE_DEPTH = 64;

  const KEYS = {
    uid: ':block/uid',
    string: ':block/string',
    children: ':block/children',
    order: ':block/order',
  };

  function isDebugEnabled() {
    return !!window.__roamBuiltinEditableTableDebug;
  }

  function debugLog(...args) {
    if (isDebugEnabled()) {
      console.log('[builtin-editable-table]', ...args);
    }
  }

  function debugWarn(...args) {
    if (isDebugEnabled()) {
      console.warn('[builtin-editable-table]', ...args);
    }
  }

  function formatProfile(profile) {
    if (!Array.isArray(profile)) {
      return '[]';
    }

    return `[${profile.join(', ')}]`;
  }

  function normalizeMarkerText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function extractTableMarkerTextCandidates(text) {
    const value = normalizeMarkerText(text);
    if (!value) {
      return [];
    }

    const candidates = [value];
    if (value === 'table' || value === '[[table]]') {
      candidates.push('{{table}}', '{{[[table]]}}');
    }

    return candidates;
  }

  function isNativeTableMarkerText(text) {
    return extractTableMarkerTextCandidates(text).some((candidate) => TABLE_MARKERS.has(candidate));
  }

  function describeVisibleTableCandidate(candidate) {
    const uid = candidate && candidate.hostUid ? candidate.hostUid : '?';
    const rawText = normalizeMarkerText(candidate && candidate.hostText ? candidate.hostText : '');
    const text = rawText.length > 80 ? `${rawText.slice(0, 77)}…` : rawText;
    return `${uid} ${JSON.stringify(text)} ${formatProfile(candidate && candidate.profile ? candidate.profile : [])}`;
  }

  if (window[PLUGIN_KEY] && typeof window[PLUGIN_KEY].destroy === 'function') {
    window[PLUGIN_KEY].destroy();
  }

  // Keep one singleton so reloading the script tears down old listeners and decorations cleanly.
  const plugin = {
    initialized: false,
    observer: null,
    pollTimer: null,
    scanTimer: null,
    scanning: false,
    rescanQueued: false,
    instances: new Map(),
    init,
    destroy,
    refresh: scheduleScan,
  };

  window[PLUGIN_KEY] = plugin;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void init();
    }, { once: true });
  } else {
    void init();
  }

  async function init() {
    if (plugin.initialized) {
      scheduleScan();
      return;
    }

    if (!window.roamAlphaAPI) {
      console.warn('[builtin-editable-table] roamAlphaAPI is not available yet.');
      setTimeout(() => {
        void init();
      }, 1000);
      return;
    }

    plugin.initialized = true;
    injectStyles();
    startObserver();
    startPolling();
    scheduleScan();
  }

  function destroy() {
    plugin.initialized = false;

    if (plugin.scanTimer) {
      clearTimeout(plugin.scanTimer);
      plugin.scanTimer = null;
    }

    if (plugin.observer) {
      plugin.observer.disconnect();
      plugin.observer = null;
    }

    if (plugin.pollTimer) {
      clearInterval(plugin.pollTimer);
      plugin.pollTimer = null;
    }

    for (const instance of plugin.instances.values()) {
      cleanupInstance(instance);
    }

    plugin.instances.clear();

    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${EDITABLE_CLASS} {
        position: relative;
        cursor: text;
        outline: none;
      }

      .${EDITABLE_CLASS}.${EDITING_CLASS} {
        overflow: hidden;
      }

      .${EDITABLE_CLASS}::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        outline: 2px solid transparent;
        outline-offset: -2px;
        z-index: 3;
      }

      .${EDITABLE_CLASS}.${SELECTED_CLASS}::after {
        outline-color: rgba(68, 132, 255, 0.48);
      }

      .${EDITABLE_CLASS}.${EDITING_CLASS}::after {
        outline-color: rgba(68, 132, 255, 0.62);
      }

      .${EDITABLE_CLASS}.${EDITING_CLASS} > *:not(textarea.${INPUT_CLASS}) {
        visibility: hidden;
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .${INPUT_CLASS} {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2;
        display: block;
        width: 100%;
        min-height: 32px;
        margin: 0;
        padding: 8px 10px;
        border: 0;
        outline: none;
        background: var(--bg-color, #fff);
        font: inherit;
        color: inherit;
        box-sizing: border-box;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        resize: none;
        overflow: hidden;
      }

      .${CONTEXT_MENU_CLASS} {
        position: fixed;
        z-index: 2147483647;
        min-width: 148px;
        padding: 6px;
        border-radius: 8px;
        border: 1px solid rgba(16, 22, 26, 0.12);
        background: var(--bg-color, #fff);
        box-shadow: 0 8px 24px rgba(16, 22, 26, 0.18);
      }

      .${CONTEXT_MENU_ITEM_CLASS} {
        display: block;
        width: 100%;
        margin: 0;
        padding: 8px 10px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .${CONTEXT_MENU_ITEM_CLASS}:hover:not(:disabled),
      .${CONTEXT_MENU_ITEM_CLASS}:focus-visible:not(:disabled) {
        background: rgba(68, 132, 255, 0.12);
        outline: none;
      }

      .${CONTEXT_MENU_ITEM_CLASS}:disabled {
        opacity: 0.48;
        cursor: default;
      }
    `;

    document.head.appendChild(style);
  }

  function startPolling() {
    if (plugin.pollTimer) {
      clearInterval(plugin.pollTimer);
    }

    plugin.pollTimer = setInterval(() => {
      scheduleScan();
    }, 1500);
  }

  function startObserver() {
    if (plugin.observer) {
      plugin.observer.disconnect();
    }

    plugin.observer = new MutationObserver(() => {
      scheduleScan();
    });

    plugin.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-uid', 'data-block-uid', 'id', 'class'],
    });
  }

  function scheduleScan() {
    if (!plugin.initialized) {
      return;
    }

    if (plugin.scanTimer) {
      clearTimeout(plugin.scanTimer);
    }

    plugin.scanTimer = setTimeout(() => {
      plugin.scanTimer = null;
      void runScan();
    }, 120);
  }

  // Scan finds visible native {{table}} hosts and only enables editing when DOM-to-block mapping is exact.
  async function runScan() {
    if (!plugin.initialized) {
      return;
    }

    if (plugin.scanning) {
      plugin.rescanQueued = true;
      return;
    }

    plugin.scanning = true;

    try {
      do {
        plugin.rescanQueued = false;
        const visibleHosts = new Set();
        const queriedHostUids = await findNativeTableHostUids();
        const candidates = collectCandidateBlocks();
        const visibleTableCandidates = collectVisibleNativeTableCandidates();
        const visibleCandidateHostUids = getVisibleNativeTableHostUids(visibleTableCandidates);
        const hostUids = Array.from(new Set([...queriedHostUids, ...visibleCandidateHostUids]));

        debugLog('scan start', {
          queriedHosts: queriedHostUids.length,
          queriedHostUids: queriedHostUids.join(', '),
          visibleCandidateHosts: visibleCandidateHostUids.length,
          visibleCandidateHostUids: visibleCandidateHostUids.join(', '),
          scanHosts: hostUids.length,
          scanHostUids: hostUids.join(', '),
          visibleCandidates: candidates.size,
          visibleTables: visibleTableCandidates.length,
          visibleTableProfiles: visibleTableCandidates.map((candidate) => formatProfile(candidate.profile)).join(' | '),
          visibleTableHosts: getVisibleNativeTableHostSummaries(visibleTableCandidates).join(' | '),
          mounted: plugin.instances.size,
        });

        if (visibleTableCandidates.length > 0) {
          debugLog('visible native table candidates', getVisibleNativeTableHostSummaries(visibleTableCandidates).join(' | '));
        }

        for (const uid of hostUids) {
          const hostElement = candidates.get(uid) || findElementForUid(uid);
          if (!hostElement) {
            continue;
          }
          candidates.set(uid, hostElement);
        }

        await resolveFallbackHostElements(hostUids, candidates, visibleTableCandidates);

        for (const uid of hostUids) {
          const hostElement = candidates.get(uid) || findElementForUid(uid);
          if (!hostElement) {
            continue;
          }

          visibleHosts.add(uid);
          const existing = plugin.instances.get(uid);
          if (existing) {
            await refreshMountedInstance(existing, hostElement);
          } else {
            await mountInstance(uid, hostElement);
          }
        }

        for (const [uid, instance] of Array.from(plugin.instances.entries())) {
          const hostElement = candidates.get(uid) || findElementForUid(uid);
          if (!visibleHosts.has(uid) || !hostElement) {
            cleanupInstance(instance);
            plugin.instances.delete(uid);
          }
        }
      } while (plugin.rescanQueued);
    } catch (error) {
      console.error('[builtin-editable-table] scan failed', error);
    } finally {
      plugin.scanning = false;
    }
  }

  async function resolveFallbackHostElements(queriedHostUids, candidates, visibleTableCandidates) {
    const usedHosts = new Set();
    for (const uid of queriedHostUids) {
      const hostElement = candidates.get(uid);
      if (!hostElement) {
        continue;
      }
      const normalized = normalizeHostElement(hostElement) || hostElement;
      if (normalized) {
        usedHosts.add(normalized);
      }
    }

    for (const uid of queriedHostUids) {
      if (candidates.has(uid)) {
        continue;
      }

      let state;
      try {
        state = await loadNativeTable(uid);
      } catch (error) {
        debugLog('failed to load native table while resolving host', {
          uid,
          error: formatError(error),
        });
        continue;
      }

      const matches = visibleTableCandidates.filter((candidate) => {
        const hostElement = normalizeHostElement(candidate.hostElement) || candidate.hostElement;
        if (!hostElement || usedHosts.has(hostElement)) {
          return false;
        }
        if (isHostMarkerMismatch(uid, candidate)) {
          return false;
        }
        return profilesMatch(state.profile, candidate.profile, { allowTrailingBlankCells: true });
      });

      if (matches.length === 1) {
        const hostElement = normalizeHostElement(matches[0].hostElement) || matches[0].hostElement;
        candidates.set(uid, hostElement);
        usedHosts.add(hostElement);
        debugLog('mapped queried native table to visible host by profile', {
          queriedUid: uid,
          domUid: getUidFromElement(hostElement) || null,
          domText: normalizeMarkerText(getHostBlockText(hostElement)),
          profile: formatProfile(state.profile),
        });
        continue;
      }

      if (matches.length > 1) {
        debugLog('native table host match is ambiguous', {
          uid,
          profile: formatProfile(state.profile),
          matches: matches.length,
          visibleCandidates: matches.map((candidate) => describeVisibleTableCandidate(candidate)).join(' | '),
        });
      } else {
        debugLog('native table host is not visibly resolved', {
          uid,
          profile: formatProfile(state.profile),
          visibleCandidates: getVisibleNativeTableHostSummaries(visibleTableCandidates).join(' | '),
        });
      }
    }
  }

  function collectVisibleNativeTableCandidates() {
    const candidates = [];
    const seenHosts = new Set();

    for (const tableElement of document.querySelectorAll('table')) {
      if (!tableElement || !isVisibleElement(tableElement)) {
        continue;
      }

      const renderedRows = collectRenderedTableRows(tableElement);
      if (renderedRows.length === 0) {
        continue;
      }

      const hasUnsupportedSpans = renderedRows.some((row) => {
        return row.cells.some((cell) => {
          return (cell.colSpan && cell.colSpan > 1) || (cell.rowSpan && cell.rowSpan > 1);
        });
      });
      if (hasUnsupportedSpans) {
        continue;
      }

      const hostElement = findNativeTableHostElementForTable(tableElement);
      if (!hostElement || seenHosts.has(hostElement) || !isVisibleElement(hostElement)) {
        continue;
      }

      seenHosts.add(hostElement);
      candidates.push({
        hostElement,
        hostUid: getHostUid(hostElement),
        hostText: getHostBlockText(hostElement),
        tableElement,
        profile: renderedRows.map((row) => row.cells.length),
      });
    }

    return candidates;
  }

  function findNativeTableHostElementForTable(tableElement) {
    const seenHosts = new Set();
    let current = tableElement;

    while (current && current !== document.body) {
      const normalized = normalizeHostElement(current);
      if (normalized && !seenHosts.has(normalized)) {
        seenHosts.add(normalized);
        if (isVisibleElement(normalized) && isNativeTableMarkerText(getHostBlockText(normalized))) {
          return normalized;
        }
      }

      const container = findHostContainer(current);
      if (container && !seenHosts.has(container)) {
        seenHosts.add(container);
        if (isVisibleElement(container) && isNativeTableMarkerText(getHostBlockText(container))) {
          return container;
        }
      }

      const next = container || normalized || current;
      current = next ? next.parentElement : null;
    }

    return findHostContainer(tableElement) || normalizeHostElement(tableElement);
  }

  function getHostUid(element) {
    const host = normalizeHostElement(element);
    if (!host) {
      return null;
    }

    if (host.dataset) {
      if (host.dataset.blockUid) {
        return host.dataset.blockUid;
      }
      if (host.dataset.uid) {
        return host.dataset.uid;
      }
    }

    const directInput = getDirectBlockInput(host);
    if (directInput) {
      return parseUidFromBlockInputId(directInput.id);
    }

    const directUidCarrier = getDirectUidCarrier(host);
    if (directUidCarrier) {
      return directUidCarrier.dataset.blockUid || directUidCarrier.dataset.uid || null;
    }

    return null;
  }

  function getHostBlockText(element) {
    const host = normalizeHostElement(element);
    if (!host) {
      return '';
    }

    const directInput = getDirectBlockInput(host);
    if (directInput) {
      const inputValue = typeof directInput.value === 'string' ? directInput.value : '';
      if (inputValue) {
        return inputValue;
      }

      const inputSpan = directInput.querySelector(':scope > span');
      if (inputSpan) {
        const cloned = inputSpan.cloneNode(true);
        for (const nestedTable of cloned.querySelectorAll('table, .rm-table, .roam-table')) {
          nestedTable.remove();
        }
        const spanText = cloned.textContent || cloned.innerText || '';
        if (normalizeMarkerText(spanText)) {
          return spanText;
        }
      }

      const inputText = directInput.textContent || directInput.innerText || '';
      if (inputText) {
        return inputText;
      }
    }

    const textRoot = getDirectBlockTextRoot(host);
    if (textRoot) {
      return textRoot.textContent || textRoot.innerText || '';
    }

    return host.textContent || host.innerText || '';
  }

  function getDirectBlockInput(host) {
    if (!host || typeof host.querySelector !== 'function') {
      return null;
    }

    for (const input of host.querySelectorAll('[id^="block-input-"]')) {
      if (!input || !host.contains(input)) {
        continue;
      }

      const inputHost = normalizeHostElement(input);
      if (inputHost === host) {
        return input;
      }
    }

    return null;
  }

  function getDirectUidCarrier(host) {
    if (!host || typeof host.querySelectorAll !== 'function') {
      return null;
    }

    for (const node of host.querySelectorAll('[data-block-uid], [data-uid]')) {
      if (!node || !host.contains(node)) {
        continue;
      }

      const nodeHost = normalizeHostElement(node);
      if (nodeHost === host) {
        return node;
      }
    }

    return null;
  }

  function getDirectBlockTextRoot(host) {
    if (!host || typeof host.querySelectorAll !== 'function') {
      return null;
    }

    const selectors = [
      '.rm-block-main .rm-block-text',
      '.rm-block-text',
      '.roam-block',
      '.bp3-popover-target',
    ];

    for (const selector of selectors) {
      for (const node of host.querySelectorAll(selector)) {
        if (!node || !host.contains(node)) {
          continue;
        }

        const nodeHost = normalizeHostElement(node);
        if (nodeHost === host) {
          return node;
        }
      }
    }

    return null;
  }

  function collectVisibleNativeTableHostsFromDom() {
    const map = new Map();

    for (const candidate of collectVisibleNativeTableCandidates()) {
      if (!isNativeTableMarkerText(candidate.hostText)) {
        continue;
      }

      if (candidate.hostUid && !map.has(candidate.hostUid)) {
        map.set(candidate.hostUid, candidate.hostElement);
      }
    }

    return map;
  }

  function getVisibleNativeTableHostSummaries(candidates) {
    return (candidates || []).map((candidate) => describeVisibleTableCandidate(candidate));
  }

  function getVisibleNativeTableHostUids(candidates) {
    const uids = new Set();

    for (const candidate of candidates || []) {
      if (candidate && candidate.hostUid) {
        uids.add(candidate.hostUid);
      }
    }

    return Array.from(uids);
  }

  function isHostMarkerMismatch(uid, candidate) {
    if (!candidate) {
      return false;
    }

    if (candidate.hostUid && candidate.hostUid !== uid) {
      return true;
    }

    if (candidate.hostText) {
      const text = normalizeMarkerText(candidate.hostText);
      if (text && !isNativeTableMarkerText(text)) {
        return true;
      }
    }

    return false;
  }

  function getCandidateUid(hostElement) {
    return getHostUid(hostElement);
  }

  function getCandidateText(hostElement) {
    return getHostBlockText(hostElement);
  }

  function isVisibleNativeTableHostElement(hostElement) {
    return isNativeTableMarkerText(getCandidateText(hostElement));
  }

  function getVisibleNativeTableHostsMap() {
    return collectVisibleNativeTableHostsFromDom();
  }

  function mergeCandidateHostMaps(primaryMap, secondaryMap) {
    const merged = new Map(primaryMap || []);
    for (const [uid, hostElement] of secondaryMap || []) {
      if (!merged.has(uid) && hostElement) {
        merged.set(uid, hostElement);
      }
    }
    return merged;
  }

  function collectCandidateBlocks() {
    const selectors = [
      '.roam-block-container',
      '.rm-block-main',
      '.roam-block[data-uid]',
      '.roam-block-container[data-uid]',
      '.rm-block-text[data-uid]',
      '[data-block-uid]',
      '[id^="block-input-"]',
    ];

    const nodes = document.querySelectorAll(selectors.join(', '));
    const map = new Map();

    for (const node of nodes) {
      const host = normalizeHostElement(node);
      const uid = getCandidateUid(host);
      if (!uid || !host || map.has(uid)) {
        continue;
      }
      if (!isVisibleElement(host)) {
        continue;
      }
      map.set(uid, host);
    }

    return mergeCandidateHostMaps(map, getVisibleNativeTableHostsMap());
  }

  function parseUidFromBlockInputId(id) {
    if (typeof id !== 'string' || !id.startsWith('block-input-')) {
      return null;
    }

    const raw = id.slice('block-input-'.length);
    const parts = raw.split('-').filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (/^[A-Za-z0-9_-]{9}$/.test(part)) {
        return part;
      }
    }

    const match = raw.match(/([A-Za-z0-9_-]{9})$/);
    return match ? match[1] : null;
  }

  function getUidFromElement(element) {
    return getHostUid(element);
  }

  async function findNativeTableHostUids() {
    const api = getApi();
    const results = new Set();

    for (const marker of TABLE_MARKERS) {
      try {
        const queryResult = await api.q(
          `[:find ?uid
            :in $ ?marker
            :where
            [?b :block/string ?marker]
            [?b :block/uid ?uid]]`,
          marker
        );

        for (const row of queryResult || []) {
          const uid = Array.isArray(row) ? row[0] : row;
          if (uid) {
            results.add(uid);
          }
        }
      } catch (error) {
        console.warn('[builtin-editable-table] native table query failed', marker, error);
      }
    }

    return Array.from(results);
  }

  function createInstance(hostUid) {
    return {
      hostUid,
      hostElement: null,
      hostContainer: null,
      tableElement: null,
      state: null,
      mappedCells: [],
      mappedByUid: new Map(),
      selected: null,
      editing: null,
      loading: false,
      loadPromise: null,
      mutating: false,
      structureState: null,
      contextMenu: null,
      disabledReason: '',
      disabledAt: 0,
      handlers: null,
      listenerTarget: null,
    };
  }

  async function refreshMountedInstance(instance, hostElement, options = {}) {
    const normalizedHost = normalizeHostElement(hostElement) || hostElement;
    instance.hostElement = normalizedHost;
    instance.hostContainer = findHostContainer(normalizedHost);

    // Entering edit mode mutates the native cell DOM on purpose by adding an overlay textarea.
    // Background scans triggered by those DOM/class changes must not immediately remount the same
    // instance, or the newly focused cell will lose focus right after activation.
    if (!options.force && instance.editing) {
      return instance;
    }

    const shouldRetryDisabled = !!instance.disabledReason && (!instance.disabledAt || Date.now() - instance.disabledAt >= DISABLED_RETRY_MS);
    const shouldRemount = options.force || shouldRetryDisabled || !isInstanceLive(instance);

    if (!shouldRemount) {
      return instance;
    }

    return mountInstance(instance.hostUid, normalizedHost, {
      instance,
      preserveSpec: Object.prototype.hasOwnProperty.call(options, 'preserveSpec') ? options.preserveSpec : instance.selected,
    });
  }

  function isInstanceLive(instance) {
    if (!instance || !instance.tableElement || !instance.tableElement.isConnected) {
      return false;
    }

    const hostContainer = instance.hostContainer || findHostContainer(instance.hostElement);
    if (!hostContainer || !hostContainer.isConnected) {
      return false;
    }

    if (!(hostContainer.contains(instance.tableElement) || instance.tableElement === hostContainer)) {
      return false;
    }

    if (!Array.isArray(instance.mappedCells) || instance.mappedCells.length === 0) {
      return false;
    }

    const renderedRows = collectRenderedTableRows(instance.tableElement);
    const renderedProfile = renderedRows.map((row) => row.cells.length);
    if (!profilesMatch(instance.state && instance.state.profile, renderedProfile, { allowTrailingBlankCells: true })) {
      debugLog('instance became stale because rendered profile changed', {
        uid: instance.hostUid,
        stateProfile: formatProfile(instance.state && instance.state.profile),
        renderedProfile: formatProfile(renderedProfile),
      });
      return false;
    }

    for (const entry of instance.mappedCells) {
      if (!entry || !entry.element || !entry.element.isConnected || !instance.tableElement.contains(entry.element)) {
        return false;
      }

      const expectedValue = getCellValue(instance.state, specFromEntry(entry));
      const renderedValue = getRenderedCellText(entry.element);
      if (expectedValue !== renderedValue) {
        debugLog('instance became stale because rendered cell text changed', {
          uid: instance.hostUid,
          cellUid: entry.cellUid,
          rowIndex: entry.rowIndex,
          colIndex: entry.colIndex,
          expectedValue,
          renderedValue,
        });
        return false;
      }
    }

    return true;
  }

  // Mount reads the native table block tree, finds the matching visible table, and decorates only safely mapped cells.
  async function mountInstance(hostUid, hostElement, options = {}) {
    const instance = options.instance || plugin.instances.get(hostUid) || createInstance(hostUid);
    plugin.instances.set(hostUid, instance);

    if (instance.loadPromise) {
      return instance.loadPromise;
    }

    const preserveSpec = Object.prototype.hasOwnProperty.call(options, 'preserveSpec') ? options.preserveSpec : instance.selected;
    const normalizedHost = normalizeHostElement(hostElement) || hostElement;
    instance.hostElement = normalizedHost;
    instance.hostContainer = findHostContainer(normalizedHost);
    instance.loading = true;
    instance.disabledReason = '';
    instance.lastMountAttemptAt = Date.now();

    instance.loadPromise = (async () => {
      cleanupInstance(instance, { preserveSelection: true, preserveState: false });
      instance.hostElement = normalizedHost;
      instance.hostContainer = findHostContainer(normalizedHost);

      try {
        instance.state = await loadNativeTable(hostUid);
      } catch (error) {
        disableInstance(instance, `Failed to load native table state: ${formatError(error)}`);
        console.warn('[builtin-editable-table] failed to load native table', hostUid, error);
        return instance;
      }

      const tableElement = findNativeTableElement(instance.hostContainer, instance.hostElement, instance.state);
      if (!tableElement) {
        disableInstance(instance, 'Visible native table DOM was not found or did not match the block tree.');
        return instance;
      }

      const mapping = buildCellMapping(tableElement, instance.state);
      if (!mapping) {
        disableInstance(instance, 'Native table cells could not be mapped safely to backing blocks.');
        return instance;
      }

      instance.tableElement = tableElement;
      instance.mappedCells = mapping.entries;
      instance.mappedByUid = buildMappedByUid(mapping.entries);
      instance.structureState = analyzeNativeTableStructure(instance.state);
      decorateMappedCells(instance);
      attachTableListeners(instance);
      instance.disabledReason = '';
      instance.disabledAt = 0;

      const restoredSpec = resolvePreservedSpec(instance, preserveSpec);
      if (restoredSpec) {
        selectCell(instance, restoredSpec, { focus: false, scroll: false });
      }

      debugLog('mount success', {
        uid: hostUid,
        rows: instance.state.rows.length,
        cells: instance.mappedCells.length,
      });

      return instance;
    })().finally(() => {
      instance.loading = false;
      instance.loadPromise = null;
    });

    return instance.loadPromise;
  }

  function disableInstance(instance, reason) {
    cleanupInstance(instance, { preserveSelection: false, preserveState: true });
    instance.disabledReason = reason;
    instance.disabledAt = Date.now();
    debugLog('instance disabled', {
      uid: instance.hostUid,
      reason,
    });
  }

  function cleanupInstance(instance, options = {}) {
    detachTableListeners(instance);
    closeContextMenu(instance);
    clearDecoratedCells(instance);

    if (instance.editing) {
      teardownEditingView(instance.editing);
      instance.editing = null;
    }

    instance.tableElement = null;
    instance.mappedCells = [];
    instance.mappedByUid = new Map();
    instance.listenerTarget = null;
    instance.structureState = null;

    if (!options.preserveSelection) {
      instance.selected = null;
    }

    if (!options.preserveState) {
      instance.state = null;
    }
  }

  function clearDecoratedCells(instance) {
    for (const entry of instance.mappedCells || []) {
      const cell = entry && entry.element;
      if (!cell) {
        continue;
      }

      if (entry.onMouseDown) {
        cell.removeEventListener('mousedown', entry.onMouseDown, true);
        entry.onMouseDown = null;
      }
      if (entry.onClick) {
        cell.removeEventListener('click', entry.onClick, true);
        entry.onClick = null;
      }
      if (entry.onKeyDown) {
        cell.removeEventListener('keydown', entry.onKeyDown, true);
        entry.onKeyDown = null;
      }

      cell.classList.remove(EDITABLE_CLASS, SELECTED_CLASS, EDITING_CLASS);
      delete cell.dataset.betCell;
      delete cell.dataset.betCellUid;
      delete cell.dataset.betRowIndex;
      delete cell.dataset.betColIndex;

      if (cell.dataset.betAddedTabindex === 'true') {
        cell.removeAttribute('tabindex');
        delete cell.dataset.betAddedTabindex;
      }
    }
  }

  function decorateMappedCells(instance) {
    for (const entry of instance.mappedCells) {
      const cell = entry.element;
      cell.classList.add(EDITABLE_CLASS);
      cell.dataset.betCell = 'true';
      cell.dataset.betCellUid = entry.cellUid;
      cell.dataset.betRowIndex = String(entry.rowIndex);
      cell.dataset.betColIndex = String(entry.colIndex);

      if (!cell.hasAttribute('tabindex')) {
        cell.tabIndex = 0;
        cell.dataset.betAddedTabindex = 'true';
      }
    }
  }

  function attachTableListeners(instance) {
    const target = instance.hostContainer || instance.hostElement || instance.tableElement;
    if (!target) {
      instance.handlers = null;
      instance.listenerTarget = null;
      return;
    }

    detachTableListeners(instance);

    const handlers = {
      onMouseDown: (event) => handleTableMouseDown(instance, event),
      onClick: (event) => {
        void handleTableClick(instance, event);
      },
      onKeyDown: (event) => handleTableKeyDown(instance, event),
      onContextMenu: (event) => {
        void handleTableContextMenu(instance, event);
      },
      onDocumentMouseDown: (event) => handleGlobalPointerDown(instance, event),
      onDocumentScroll: () => closeContextMenu(instance),
      onDocumentKeyDown: (event) => handleGlobalKeyDown(instance, event),
    };

    instance.handlers = handlers;
    instance.listenerTarget = target;
    target.addEventListener('mousedown', handlers.onMouseDown, true);
    target.addEventListener('click', handlers.onClick, true);
    target.addEventListener('keydown', handlers.onKeyDown, true);
    target.addEventListener('contextmenu', handlers.onContextMenu, true);
    document.addEventListener('mousedown', handlers.onDocumentMouseDown, true);
    document.addEventListener('scroll', handlers.onDocumentScroll, true);
    document.addEventListener('keydown', handlers.onDocumentKeyDown, true);
  }

  function detachTableListeners(instance) {
    if (!instance.listenerTarget || !instance.handlers) {
      instance.handlers = null;
      instance.listenerTarget = null;
      return;
    }

    instance.listenerTarget.removeEventListener('mousedown', instance.handlers.onMouseDown, true);
    instance.listenerTarget.removeEventListener('click', instance.handlers.onClick, true);
    instance.listenerTarget.removeEventListener('keydown', instance.handlers.onKeyDown, true);
    instance.listenerTarget.removeEventListener('contextmenu', instance.handlers.onContextMenu, true);
    document.removeEventListener('mousedown', instance.handlers.onDocumentMouseDown, true);
    document.removeEventListener('scroll', instance.handlers.onDocumentScroll, true);
    document.removeEventListener('keydown', instance.handlers.onDocumentKeyDown, true);
    instance.handlers = null;
    instance.listenerTarget = null;
  }

  function remapInstanceToCurrentDom(instance) {
    if (!instance || !instance.state) {
      return false;
    }

    const hostContainer = instance.hostContainer || findHostContainer(instance.hostElement);
    const hostElement = instance.hostElement || findElementForUid(instance.hostUid);
    if (!hostContainer || !hostElement) {
      return false;
    }

    const tableElement = findNativeTableElement(hostContainer, hostElement, instance.state);
    if (!tableElement) {
      return false;
    }

    if (instance.tableElement === tableElement && Array.isArray(instance.mappedCells) && instance.mappedCells.length > 0) {
      return true;
    }

    clearDecoratedCells(instance);
    instance.tableElement = tableElement;
    const mapping = buildCellMapping(tableElement, instance.state);
    if (!mapping) {
      instance.mappedCells = [];
      instance.mappedByUid = new Map();
      instance.structureState = analyzeNativeTableStructure(instance.state);
      return false;
    }

    instance.mappedCells = mapping.entries;
    instance.mappedByUid = buildMappedByUid(mapping.entries);
    instance.structureState = analyzeNativeTableStructure(instance.state);
    decorateMappedCells(instance);
    return true;
  }

  function ensureInteractiveMapping(instance) {
    if (!instance) {
      return false;
    }

    if (isInstanceLive(instance)) {
      return true;
    }

    return remapInstanceToCurrentDom(instance);
  }

  async function activateCell(instance, cell) {
    const spec = specFromCell(cell);
    if (!spec) {
      debugWarn('activateCell skipped because spec is missing');
      return;
    }

    debugLog('activateCell', spec);

    if (instance.editing) {
      if (sameSpec(instance.editing.spec, spec)) {
        return;
      }
      try {
        await waitForEditCompletion(instance);
      } catch (error) {
        console.warn('[builtin-editable-table] failed to finish previous edit before switching cell', error);
        return;
      }
    }

    selectCell(instance, spec);
    try {
      await beginEdit(instance, spec);
    } catch (error) {
      console.warn('[builtin-editable-table] failed to begin edit', error);
    }
  }

  function isEditInputTarget(target) {
    const element = getEventTargetElement(target);
    return !!(element && typeof element.closest === 'function' && element.closest(`textarea.${INPUT_CLASS}`));
  }

  function handleTableMouseDown(instance, event) {
    if (isEditInputTarget(event.target)) {
      event.stopPropagation();
      return;
    }

    if (!ensureInteractiveMapping(instance)) {
      debugWarn('mousedown ignored because interactive mapping is unavailable', instance && instance.hostUid);
      return;
    }

    const cell = closestEditableCell(instance, event.target);
    if (!cell) {
      return;
    }

    debugLog('mousedown cell hit', specFromCell(cell));

    event.preventDefault();
    event.stopPropagation();
    queueMicrotask(() => {
      if (!instance.loading) {
        void activateCell(instance, cell);
      }
    });
  }

  // Click is only suppressed here in case the browser still dispatches it after mousedown activation.
  async function handleTableClick(instance, event) {
    if (isEditInputTarget(event.target)) {
      event.stopPropagation();
      return;
    }

    if (!ensureInteractiveMapping(instance)) {
      return;
    }

    const cell = closestEditableCell(instance, event.target);
    if (!cell) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  function handleTableKeyDown(instance, event) {
    if (!ensureInteractiveMapping(instance)) {
      return;
    }

    const targetElement = getEventTargetElement(event.target);
    if (!instance.tableElement || !targetElement || !instance.tableElement.contains(targetElement)) {
      return;
    }

    if (isEditInputTarget(event.target)) {
      return;
    }

    const cell = closestEditableCell(instance, event.target);
    if (!cell) {
      return;
    }

    const spec = specFromCell(cell);
    if (!spec) {
      return;
    }

    if (instance.editing) {
      event.stopPropagation();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      selectCell(instance, spec);
      void beginEdit(instance, spec);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const nextSpec = getAdjacentSpec(instance, spec, event.shiftKey ? -1 : 1);
      selectCell(instance, nextSpec);
    }
  }

  async function handleTableContextMenu(instance, event) {
    if (!ensureInteractiveMapping(instance)) {
      return;
    }

    const cell = closestEditableCell(instance, event.target);
    if (!cell) {
      closeContextMenu(instance);
      return;
    }

    const spec = specFromCell(cell);
    if (!spec) {
      closeContextMenu(instance);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (instance.editing && !sameSpec(instance.editing.spec, spec)) {
      try {
        await waitForEditCompletion(instance);
      } catch (error) {
        console.warn('[builtin-editable-table] failed to finish edit before opening context menu', error);
        return;
      }
    }

    selectCell(instance, spec, { focus: false, scroll: false });
    openContextMenu(instance, spec, {
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handleGlobalPointerDown(instance, event) {
    if (!instance || !instance.contextMenu) {
      return;
    }

    const element = getEventTargetElement(event.target);
    const menuElement = instance.contextMenu && instance.contextMenu.element;
    if (menuElement && element && menuElement.contains(element)) {
      return;
    }

    closeContextMenu(instance);
  }

  function handleGlobalKeyDown(instance, event) {
    if (event.key === 'Escape') {
      closeContextMenu(instance);
    }
  }

  function openContextMenu(instance, spec, position) {
    closeContextMenu(instance);

    const availability = getContextMenuAvailability(instance, spec);
    const menuElement = renderContextMenu(instance, spec, availability);
    if (!menuElement) {
      return;
    }

    document.body.appendChild(menuElement);
    placeContextMenu(menuElement, position);
    instance.contextMenu = {
      element: menuElement,
      spec,
      availability,
    };
  }

  function closeContextMenu(instance) {
    if (!instance || !instance.contextMenu) {
      return;
    }

    const menu = instance.contextMenu;
    instance.contextMenu = null;
    if (menu.element && menu.element.parentElement) {
      menu.element.remove();
    }
  }

  function renderContextMenu(instance, spec, availability) {
    const menuElement = document.createElement('div');
    menuElement.className = CONTEXT_MENU_CLASS;
    menuElement.setAttribute('role', 'menu');

    const items = [
      { action: 'add-row', label: 'Add row', disabled: !!availability.addRow.disabled },
      { action: 'add-column', label: 'Add Column', disabled: !!availability.addColumn.disabled },
      { action: 'delete-row', label: 'Delete row', disabled: !!availability.deleteRow.disabled },
      { action: 'delete-column', label: 'Delete Column', disabled: !!availability.deleteColumn.disabled },
    ];

    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = CONTEXT_MENU_ITEM_CLASS;
      button.textContent = item.label;
      button.disabled = item.disabled;
      button.setAttribute('role', 'menuitem');
      button.setAttribute(CONTEXT_MENU_ACTION_ATTR, item.action);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void handleContextMenuAction(instance, item.action, spec);
      });
      menuElement.appendChild(button);
    });

    return menuElement;
  }

  function placeContextMenu(menuElement, position) {
    if (!menuElement) {
      return;
    }

    const padding = 8;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const rect = menuElement.getBoundingClientRect();
    const width = rect.width || 160;
    const height = rect.height || 160;
    const left = Math.max(padding, Math.min(position.x, Math.max(padding, viewportWidth - width - padding)));
    const top = Math.max(padding, Math.min(position.y, Math.max(padding, viewportHeight - height - padding)));
    menuElement.style.left = `${left}px`;
    menuElement.style.top = `${top}px`;
  }

  async function handleContextMenuAction(instance, action, spec) {
    const actionSpec = spec ? { ...spec } : spec;
    closeContextMenu(instance);
    selectCell(instance, actionSpec, { focus: false, scroll: false });

    switch (action) {
      case 'add-row':
        await addNativeTableRow(instance, actionSpec);
        return;
      case 'delete-row':
        await deleteNativeTableRow(instance, actionSpec);
        return;
      case 'add-column':
        await addNativeTableColumn(instance, actionSpec);
        return;
      case 'delete-column':
        await deleteNativeTableColumn(instance, actionSpec);
        return;
      default:
        return;
    }
  }

  async function runStructuralMutation(instance, actionName, preserveSpec, work) {
    if (!instance || instance.mutating || instance.loading) {
      return;
    }

    const nextSpec = preserveSpec ? { ...preserveSpec } : null;
    instance.mutating = true;
    closeContextMenu(instance);

    try {
      await waitForEditCompletion(instance);
      if (!ensureInteractiveMapping(instance)) {
        throw new Error('Native table mapping is unavailable.');
      }

      instance.structureState = analyzeNativeTableStructure(instance.state);
      const mutationGuardReason = getStructureMutationDisabledReason(instance, preserveSpec, { ignoreMutating: true });
      if (mutationGuardReason) {
        throw new Error(mutationGuardReason);
      }

      await work(instance.structureState, nextSpec || preserveSpec);
      await refreshInstance(instance, nextSpec || preserveSpec);
      instance.structureState = analyzeNativeTableStructure(instance.state);
      const restoredSpec = resolvePreservedSpec(instance, nextSpec || preserveSpec) || findClosestSpec(instance, nextSpec || preserveSpec);
      if (restoredSpec) {
        selectCell(instance, restoredSpec, { focus: false, scroll: false });
      }
    } catch (error) {
      console.warn(`[builtin-editable-table] ${actionName} failed`, error);
    } finally {
      instance.mutating = false;
    }
  }

  async function updateBlockString(uid, string) {
    await getApi().updateBlock({
      block: {
        uid,
        string,
      },
    });
  }

  async function addNativeTableRow(instance, spec) {
    await runStructuralMutation(instance, 'add row', spec, async (structureState, nextSpec) => {
      const row = structureState.rows[spec.rowIndex];
      if (!row) {
        throw new Error('Target row was not found.');
      }

      const newRootUid = await createChildBlock(instance.hostUid, row.rootOrderIndex + 1, '');
      let parentUid = newRootUid;
      for (let colIndex = 1; colIndex < structureState.columnCount; colIndex += 1) {
        parentUid = await createChildBlock(parentUid, 0, '');
      }

      nextSpec.rowIndex = Math.max(0, Math.min(spec.rowIndex + 1, structureState.rowCount));
      nextSpec.colIndex = Math.max(0, Math.min(spec.colIndex, Math.max(0, structureState.columnCount - 1)));
      nextSpec.cellUid = '';
    });
  }

  async function deleteNativeTableRow(instance, spec) {
    await runStructuralMutation(instance, 'delete row', spec, async (structureState, nextSpec) => {
      if (spec.rowIndex === 0) {
        return;
      }

      const row = structureState.rows[spec.rowIndex];
      if (!row || !row.rowRootUid) {
        throw new Error('Target row root was not found.');
      }

      await deleteBlock(row.rowRootUid);
      nextSpec.rowIndex = Math.max(0, Math.min(spec.rowIndex, Math.max(0, structureState.rowCount - 2)));
      nextSpec.colIndex = Math.max(0, Math.min(spec.colIndex, Math.max(0, structureState.columnCount - 1)));
      nextSpec.cellUid = '';
    });
  }

  async function addNativeTableColumn(instance, spec) {
    await runStructuralMutation(instance, 'add column', spec, async (structureState, nextSpec) => {
      const insertColIndex = spec.colIndex + 1;
      if (insertColIndex < 1 || insertColIndex > structureState.columnCount) {
        throw new Error('Target insert column is unavailable.');
      }

      await appendBlankTailToAllRows(structureState);
      const refreshedStructureState = await reloadStructureState(instance);
      await shiftColumnsRight(refreshedStructureState, insertColIndex);

      nextSpec.rowIndex = Math.max(0, Math.min(spec.rowIndex, Math.max(0, refreshedStructureState.rowCount - 1)));
      nextSpec.colIndex = Math.max(0, Math.min(insertColIndex, Math.max(0, refreshedStructureState.columnCount - 1)));
      nextSpec.cellUid = '';
    });
  }

  async function deleteNativeTableColumn(instance, spec) {
    await runStructuralMutation(instance, 'delete column', spec, async (structureState, nextSpec) => {
      if (spec.colIndex === 0) {
        return;
      }

      const deleteColIndex = spec.colIndex;
      if (deleteColIndex >= structureState.columnCount) {
        throw new Error('Target delete column is unavailable.');
      }

      if (deleteColIndex < structureState.columnCount - 1) {
        await shiftColumnsLeft(structureState, deleteColIndex);
      }
      await deleteTailNodeFromAllRows(structureState);

      nextSpec.rowIndex = Math.max(0, Math.min(spec.rowIndex, Math.max(0, structureState.rowCount - 1)));
      nextSpec.colIndex = Math.max(0, Math.min(deleteColIndex, Math.max(0, structureState.columnCount - 2)));
      nextSpec.cellUid = '';
    });
  }

  async function shiftColumnsRight(structureState, insertColIndex) {
    for (const row of structureState.rows) {
      for (let colIndex = structureState.columnCount - 1; colIndex > insertColIndex; colIndex -= 1) {
        const sourceNode = row.chain[colIndex - 1];
        const targetNode = row.chain[colIndex];
        if (!sourceNode || !targetNode) {
          throw new Error('Column shift target is unavailable.');
        }
        await updateBlockString(targetNode.uid, sourceNode.string || '');
      }

      const insertedNode = row.chain[insertColIndex];
      if (!insertedNode) {
        throw new Error('Inserted column target is unavailable.');
      }
      await updateBlockString(insertedNode.uid, '');
    }
  }

  async function shiftColumnsLeft(structureState, deleteColIndex) {
    for (const row of structureState.rows) {
      for (let colIndex = deleteColIndex; colIndex < structureState.columnCount - 1; colIndex += 1) {
        const sourceNode = row.chain[colIndex + 1];
        const targetNode = row.chain[colIndex];
        if (!sourceNode || !targetNode) {
          throw new Error('Column shift target is unavailable.');
        }
        await updateBlockString(targetNode.uid, sourceNode.string || '');
      }
    }
  }

  async function appendBlankTailToAllRows(structureState) {
    for (const row of structureState.rows) {
      const tail = row.chain[row.chain.length - 1];
      if (!tail || !tail.uid) {
        throw new Error('A row tail is unavailable.');
      }
      await createChildBlock(tail.uid, 0, '');
    }
  }

  async function deleteTailNodeFromAllRows(structureState) {
    for (const row of structureState.rows) {
      const tail = row.chain[row.chain.length - 1];
      if (!tail || !tail.uid) {
        throw new Error('A row tail is unavailable.');
      }
      await deleteBlock(tail.uid);
    }
  }

  async function reloadStructureState(instance) {
    const refreshedState = await loadNativeTable(instance.hostUid);
    const refreshedStructureState = analyzeNativeTableStructure(refreshedState);
    if (!refreshedStructureState || !refreshedStructureState.safe) {
      throw new Error(refreshedStructureState && refreshedStructureState.reason ? refreshedStructureState.reason : 'Table structure is not safe for row/column updates.');
    }
    return refreshedStructureState;
  }

  function findClosestSpec(instance, spec) {
    if (!instance || !instance.state || !Array.isArray(instance.state.rows) || instance.state.rows.length === 0) {
      return null;
    }

    const safeRowIndex = Math.max(0, Math.min(spec && Number.isInteger(spec.rowIndex) ? spec.rowIndex : 0, instance.state.rows.length - 1));
    const row = instance.state.rows[safeRowIndex];
    if (!row || !Array.isArray(row.cells) || row.cells.length === 0) {
      return null;
    }

    const safeColIndex = Math.max(0, Math.min(spec && Number.isInteger(spec.colIndex) ? spec.colIndex : 0, row.cells.length - 1));
    const cell = row.cells[safeColIndex];
    if (!cell) {
      return null;
    }

    return {
      cellUid: cell.uid,
      rowIndex: safeRowIndex,
      colIndex: safeColIndex,
    };
  }

  async function createChildBlock(parentUid, order, string, uid) {
    const blockUid = uid || generateUid();
    await getApi().createBlock({
      location: {
        'parent-uid': parentUid,
        order,
      },
      block: {
        uid: blockUid,
        string,
      },
    });
    return blockUid;
  }

  async function deleteBlock(uid) {
    await getApi().deleteBlock({
      block: {
        uid,
      },
    });
  }

  function generateUid() {
    const api = getApi();
    if (api.util && typeof api.util.generateUID === 'function') {
      return api.util.generateUID();
    }
    return `betable-${Math.random().toString(36).slice(2, 11)}`;
  }

  function getContextMenuAvailability(instance, spec) {
    const disabledReason = getStructureMutationDisabledReason(instance, spec);
    const canMutateStructure = !disabledReason;

    return {
      addRow: {
        disabled: !canMutateStructure,
        reason: disabledReason,
      },
      addColumn: {
        disabled: !canMutateStructure,
        reason: disabledReason,
      },
      deleteRow: {
        disabled: !canMutateStructure || !spec || spec.rowIndex === 0,
        reason: !canMutateStructure ? disabledReason : (spec && spec.rowIndex === 0 ? 'Header row cannot be deleted.' : ''),
      },
      deleteColumn: {
        disabled: !canMutateStructure || !spec || spec.colIndex === 0,
        reason: !canMutateStructure ? disabledReason : (spec && spec.colIndex === 0 ? 'Header column cannot be deleted.' : ''),
      },
    };
  }

  function getStructureMutationDisabledReason(instance, spec, options = {}) {
    const ignoreMutating = !!(options && options.ignoreMutating);

    if (!instance) {
      return 'Table instance is unavailable.';
    }
    if (!spec) {
      return 'Target cell is unavailable.';
    }
    if (instance.loading) {
      return 'Table is loading.';
    }
    if (instance.mutating && !ignoreMutating) {
      return 'Table structure is updating.';
    }
    if (instance.disabledReason) {
      return instance.disabledReason;
    }
    const structureState = instance.structureState || analyzeNativeTableStructure(instance.state);
    instance.structureState = structureState;
    if (!structureState || !structureState.safe) {
      return structureState && structureState.reason ? structureState.reason : 'Table structure is not safe for row/column updates.';
    }
    const row = structureState.rows[spec.rowIndex];
    if (!row) {
      return 'Target row is unavailable.';
    }
    if (!row.chain[spec.colIndex]) {
      return 'Target column is unavailable.';
    }
    return '';
  }

  function analyzeNativeTableStructure(state) {
    if (!state || !Array.isArray(state.rows) || state.rows.length === 0) {
      return {
        safe: false,
        reason: 'Table state is unavailable.',
        rowCount: 0,
        columnCount: 0,
        rows: [],
      };
    }

    const rows = state.rows.map((row) => ({
      rowIndex: row.rowIndex,
      rowUid: row.uid,
      rowRootUid: row.rootUid,
      rootOrderIndex: row.rootOrderIndex,
      chain: Array.isArray(row.path) ? row.path.map((node) => ({ ...node })) : [],
      tailUid: row.path && row.path.length ? row.path[row.path.length - 1].uid : '',
    }));

    const columnCount = rows.reduce((max, row) => Math.max(max, row.chain.length), 0);
    const allUids = new Set();
    for (const row of rows) {
      if (!row.rowRootUid) {
        return {
          safe: false,
          reason: 'A visible row is missing its root block uid.',
          rowCount: rows.length,
          columnCount,
          rows,
        };
      }
      if (row.chain.length !== columnCount) {
        return {
          safe: false,
          reason: 'Visible rows do not share one stable linear column depth.',
          rowCount: rows.length,
          columnCount,
          rows,
        };
      }
      for (const node of row.chain) {
        if (!node.uid) {
          return {
            safe: false,
            reason: 'A visible cell is missing its backing block uid.',
            rowCount: rows.length,
            columnCount,
            rows,
          };
        }
        if (allUids.has(node.uid)) {
          return {
            safe: false,
            reason: 'This native table reuses backing blocks across visible rows, so structural updates are disabled.',
            rowCount: rows.length,
            columnCount,
            rows,
          };
        }
        allUids.add(node.uid);
      }
    }

    return {
      safe: true,
      reason: '',
      rowCount: rows.length,
      columnCount,
      rows,
    };
  }

  function getEventTargetElement(target) {
    if (!target) {
      return null;
    }

    if (target.nodeType === 1) {
      return target;
    }

    return target.parentElement || null;
  }

  function closestEditableCell(instance, target) {
    if (!instance.tableElement) {
      return null;
    }

    const element = getEventTargetElement(target);
    if (!element || typeof element.closest !== 'function') {
      return null;
    }

    const cell = element.closest(`[${CELL_ATTR}="true"]`);
    if (!cell || !instance.tableElement.contains(cell)) {
      return null;
    }

    return cell;
  }

  function specFromCell(cell) {
    if (!cell || !cell.dataset || !cell.dataset.betCellUid) {
      return null;
    }

    const rowIndex = Number(cell.dataset.betRowIndex);
    const colIndex = Number(cell.dataset.betColIndex);
    if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) {
      return null;
    }

    return {
      cellUid: cell.dataset.betCellUid,
      rowIndex,
      colIndex,
    };
  }

  // Native table paths can reuse the same backing cell UID across multiple visible rows.
  // For visible-cell identity, prefer row/col position and only use UID as a consistency check.
  function sameSpec(a, b) {
    if (!a || !b) {
      return false;
    }

    if (Number.isInteger(a.rowIndex) && Number.isInteger(a.colIndex) && Number.isInteger(b.rowIndex) && Number.isInteger(b.colIndex)) {
      return a.rowIndex === b.rowIndex && a.colIndex === b.colIndex && (!a.cellUid || !b.cellUid || a.cellUid === b.cellUid);
    }

    if (a.cellUid && b.cellUid) {
      return a.cellUid === b.cellUid;
    }

    return false;
  }

  // When a backing UID appears in multiple visible cells, resolve the exact rendered cell by row/col first.
  // This avoids selection/edit navigation drifting to a different visible path that shares the same prefix UID.

  function specFromEntry(entry) {
    return {
      cellUid: entry.cellUid,
      rowIndex: entry.rowIndex,
      colIndex: entry.colIndex,
    };
  }

  function findMappedEntry(instance, spec) {
    if (!instance || !spec) {
      return null;
    }

    if (spec.cellUid && instance.mappedByUid.has(spec.cellUid)) {
      const direct = instance.mappedByUid.get(spec.cellUid);
      if (Array.isArray(direct)) {
        const matched = direct.find((entry) => {
          return entry.rowIndex === spec.rowIndex && entry.colIndex === spec.colIndex;
        });
        if (matched) {
          return matched;
        }
        return direct[0] || null;
      }
      return direct || null;
    }

    return (instance.mappedCells || []).find((entry) => {
      return entry.rowIndex === spec.rowIndex && entry.colIndex === spec.colIndex;
    }) || null;
  }

  function buildMappedByUid(entries) {
    const mapped = new Map();

    for (const entry of entries || []) {
      if (!entry || !entry.cellUid) {
        continue;
      }
      const existing = mapped.get(entry.cellUid);
      if (!existing) {
        mapped.set(entry.cellUid, entry);
        continue;
      }
      if (Array.isArray(existing)) {
        existing.push(entry);
        continue;
      }
      mapped.set(entry.cellUid, [existing, entry]);
    }

    return mapped;
  }

  function resolvePreservedSpec(instance, spec) {
    const entry = findMappedEntry(instance, spec);
    return entry ? specFromEntry(entry) : null;
  }

  function clearSelection(instance) {
    if (!instance) {
      return;
    }

    instance.selected = null;
    for (const entry of instance.mappedCells || []) {
      if (entry.element) {
        entry.element.classList.remove(SELECTED_CLASS);
      }
    }
  }

  function selectCell(instance, spec, options = {}) {
    instance.selected = spec;

    for (const entry of instance.mappedCells || []) {
      if (entry.element) {
        entry.element.classList.remove(SELECTED_CLASS);
      }
    }

    const entry = findMappedEntry(instance, spec);
    if (!entry || !entry.element) {
      return;
    }

    const cell = entry.element;
    cell.classList.add(SELECTED_CLASS);

    const shouldFocus = options.focus !== false;
    const shouldScroll = options.scroll !== false;
    if (shouldFocus) {
      cell.focus({ preventScroll: !shouldScroll });
    }
  }

  function getAdjacentSpec(instance, spec, delta) {
    const cells = (instance.mappedCells || []).map((entry) => specFromEntry(entry));
    const currentIndex = cells.findIndex((item) => sameSpec(item, spec));
    if (currentIndex === -1) {
      return spec;
    }

    const nextIndex = currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= cells.length) {
      return spec;
    }

    return cells[nextIndex] || spec;
  }

  function getCellValue(state, spec) {
    if (!state || !state.cellsByUid || !spec || !spec.cellUid) {
      return '';
    }

    const cell = state.cellsByUid.get(spec.cellUid);
    return cell && typeof cell.string === 'string' ? cell.string : '';
  }

  // Native table cells can be taller than their text content and Roam visually centers that content.
  // If the overlay editor always stretches to full cell height, textarea text sits at the top and no
  // longer matches the native cell appearance. If content grows beyond the original cell height, the
  // cell itself must grow too; otherwise the absolutely positioned textarea starts scrolling inside a
  // fixed-height cell and the visible highlight no longer matches the edit surface.
  function autoSizeEditInput(input, baseCellHeight = 0) {
    if (!input || input.tagName !== 'TEXTAREA') {
      return;
    }

    const cell = input.parentElement;
    if (!cell) {
      return;
    }

    const baseVerticalPadding = 8;
    const baseHorizontalPadding = 10;
    const resolvedBaseCellHeight = Number.isFinite(baseCellHeight) && baseCellHeight > 0
      ? baseCellHeight
      : (cell.clientHeight || 32);

    input.style.paddingTop = `${baseVerticalPadding}px`;
    input.style.paddingBottom = `${baseVerticalPadding}px`;
    input.style.paddingLeft = `${baseHorizontalPadding}px`;
    input.style.paddingRight = `${baseHorizontalPadding}px`;
    input.style.top = '0px';
    input.style.height = 'auto';
    input.style.overflowY = 'hidden';

    let targetHeight = Math.max(32, Math.ceil(input.scrollHeight) + 4);
    input.style.height = `${targetHeight}px`;

    const overflowDelta = Math.max(0, Math.ceil(input.scrollHeight - input.clientHeight));
    if (overflowDelta > 0) {
      targetHeight += overflowDelta + 2;
      input.style.height = `${targetHeight}px`;
    }

    const resolvedCellHeight = Math.max(32, resolvedBaseCellHeight, targetHeight);
    const topOffset = resolvedCellHeight > targetHeight ? Math.floor((resolvedCellHeight - targetHeight) / 2) : 0;

    cell.style.height = `${resolvedCellHeight}px`;
    cell.style.minHeight = `${resolvedCellHeight}px`;
    input.style.top = `${topOffset}px`;
    input.scrollTop = 0;
  }

  function restoreEditingCellLayout(editing) {
    if (!editing || !editing.cell) {
      return;
    }

    editing.cell.style.height = editing.originalCellHeightStyle;
    editing.cell.style.minHeight = editing.originalCellMinHeightStyle;
  }

  function captureCellLayout(cell) {
    return {
      originalCellHeightStyle: cell ? cell.style.height : '',
      originalCellMinHeightStyle: cell ? cell.style.minHeight : '',
    };
  }

  function getCellVisualHeight(cell) {
    if (!cell) {
      return 32;
    }

    const rectHeight = Math.ceil(cell.getBoundingClientRect().height || 0);
    const clientHeight = Math.ceil(cell.clientHeight || 0);
    return Math.max(32, rectHeight, clientHeight);
  }

  function applyEditingCellLayout(editing) {
    if (!editing || !editing.input) {
      return;
    }

    autoSizeEditInput(editing.input, editing.baseCellHeight);
  }

  function resizeEditingFromInput(instance, input) {
    if (!instance || !instance.editing || instance.editing.input !== input) {
      return;
    }

    applyEditingCellLayout(instance.editing);
    requestAnimationFrame(() => {
      if (instance.editing && instance.editing.input === input && input.isConnected) {
        applyEditingCellLayout(instance.editing);
      }
    });
  }
  function beginObserveEditingCell(editing) {
    if (!editing || !editing.cell || typeof ResizeObserver !== 'function') {
      return;
    }

    const observer = new ResizeObserver(() => {
      applyEditingCellLayout(editing);
    });
    observer.observe(editing.cell);
    editing.resizeObserver = observer;
  }

  function stopObserveEditingCell(editing) {
    if (editing && editing.resizeObserver) {
      editing.resizeObserver.disconnect();
      editing.resizeObserver = null;
    }
  }

  function finalizeEditingCellLayout(editing) {
    stopObserveEditingCell(editing);
    restoreEditingCellLayout(editing);
  }

  function primeEditingCellLayout(editing) {
    applyEditingCellLayout(editing);
    beginObserveEditingCell(editing);
  }

  function scheduleEditingCellLayout(editing) {
    if (!editing || !editing.input) {
      return;
    }

    requestAnimationFrame(() => {
      if (editing.input && editing.input.isConnected) {
        applyEditingCellLayout(editing);
      }
    });
  }

  function attachEditingInputResize(instance, input) {
    input.addEventListener('input', () => {
      resizeEditingFromInput(instance, input);
    });
  }

  function focusEditingInput(editing) {
    if (!editing || !editing.input) {
      return;
    }

    applyEditingCellLayout(editing);
    const input = editing.input;
    input.focus({ preventScroll: true });
    const caretPosition = input.value.length;
    input.setSelectionRange(caretPosition, caretPosition);
    requestAnimationFrame(() => {
      if (editing.input && editing.input.isConnected) {
        applyEditingCellLayout(editing);
      }
    });
  }

  function installEditingInputGuards(input) {
    input.addEventListener('mousedown', handleEditMouseEvent);
    input.addEventListener('click', handleEditMouseEvent);
  }

  function wireEditingInput(instance, editing) {
    const input = editing.input;
    input.addEventListener('keydown', (event) => {
      void handleEditKeyDown(instance, event);
    });
    attachEditingInputResize(instance, input);
    input.addEventListener('blur', () => {
      void handleEditBlur(instance);
    });
    installEditingInputGuards(input);
  }

  function mountEditingInput(editing) {
    editing.cell.appendChild(editing.input);
    applyEditingCellLayout(editing);
    focusEditingInput(editing);
    scheduleEditingCellLayout(editing);
  }

  function createEditingState(spec, cell, input, initialValue) {
    return {
      spec,
      cell,
      input,
      initialValue,
      promise: null,
      resizeObserver: null,
      baseCellHeight: getCellVisualHeight(cell),
      ...captureCellLayout(cell),
    };
  }

  function setEditingCellActive(cell) {
    cell.classList.add(SELECTED_CLASS, EDITING_CLASS);
  }

  function clearExistingEditingInputs(cell) {
    for (const existingInput of cell.querySelectorAll(`:scope > textarea.${INPUT_CLASS}`)) {
      existingInput.remove();
    }
  }

  function createEditInput(initialValue) {
    const input = document.createElement('textarea');
    input.className = INPUT_CLASS;
    input.value = initialValue;
    input.rows = 1;
    input.autocomplete = 'off';
    input.spellcheck = false;
    return input;
  }

  function prepareEditingCell(cell) {
    clearExistingEditingInputs(cell);
    return cell;
  }

  function beginEditingSession(instance, spec, cell, initialValue) {
    const preparedCell = prepareEditingCell(cell);
    const input = createEditInput(initialValue);
    const editing = createEditingState(spec, preparedCell, input, initialValue);
    instance.editing = editing;
    wireEditingInput(instance, editing);
    primeEditingCellLayout(editing);
    mountEditingInput(editing);
    return editing;
  }

  function markSelectedForEditing(instance, spec, cell) {
    instance.selected = spec;
    setEditingCellActive(cell);
  }

  function ensureEditingTargetEntry(instance, spec) {
    const entry = findMappedEntry(instance, spec);
    return entry && entry.element ? entry : null;
  }

  function beginEditingAtEntry(instance, spec, entry) {
    const cell = entry.element;
    const initialValue = getCellValue(instance.state, spec);
    markSelectedForEditing(instance, spec, cell);
    return beginEditingSession(instance, spec, cell, initialValue);
  }

  function restoreEditingInputFocus(editing) {
    if (!editing || !editing.input || !editing.input.isConnected) {
      return;
    }

    focusEditingInput(editing);
  }

  function syncEditingLayoutAfterMount(editing) {
    if (!editing) {
      return;
    }

    scheduleEditingCellLayout(editing);
    restoreEditingInputFocus(editing);
  }

  function startEditingAtSpec(instance, spec) {
    const entry = ensureEditingTargetEntry(instance, spec);
    if (!entry) {
      return null;
    }

    const editing = beginEditingAtEntry(instance, spec, entry);
    syncEditingLayoutAfterMount(editing);
    return editing;
  }

  // Root cause note: replacing a native <td>'s innerHTML during edit can destabilize Roam's own
  // renderer and, on blur/remount, cause the host native {{table}} block to fall into a
  // "Failed to render" state. Keep Roam's DOM intact and only overlay a temporary textarea.
  async function beginEdit(instance, spec) {
    if (!instance.state || instance.loading) {
      debugWarn('beginEdit skipped because instance is not ready', {
        hasState: !!instance.state,
        loading: !!instance.loading,
        spec,
      });
      return;
    }

    debugLog('beginEdit', spec);

    if (instance.editing) {
      if (sameSpec(instance.editing.spec, spec)) {
        return;
      }
      await commitEdit(instance, { navigate: 0 });
    }

    const editing = startEditingAtSpec(instance, spec);
    if (!editing) {
      return;
    }
  }

  // Tear down only the temporary overlay editor. Do not restore or rewrite native cell HTML.
  // This path can race with blur/save/remount cleanup, so teardown must be idempotent.
  function teardownEditingView(editing) {
    if (!editing || !editing.cell) {
      return;
    }

    const cell = editing.cell;
    cell.classList.remove(EDITING_CLASS);
    finalizeEditingCellLayout(editing);

    const input = editing.input;
    if (!input) {
      return;
    }

    const parent = input.parentNode;
    if (!parent) {
      return;
    }

    try {
      if (typeof parent.removeChild === 'function' && parent.contains(input)) {
        parent.removeChild(input);
      }
    } catch (_error) {
      return;
    }
  }

  function cancelEdit(instance) {
    const editing = instance.editing;
    if (!editing) {
      return;
    }

    instance.editing = null;
    teardownEditingView(editing);
    selectCell(instance, editing.spec);
  }

  async function waitForEditCompletion(instance) {
    if (!instance.editing) {
      return;
    }

    if (instance.editing.promise) {
      await instance.editing.promise;
      return;
    }

    await commitEdit(instance, { navigate: 0, focus: false });
  }

  async function refreshInstance(instance, preserveSpec) {
    const hostElement = findElementForUid(instance.hostUid) || instance.hostElement;
    if (!hostElement) {
      disableInstance(instance, 'Native table host is no longer visible.');
      return instance;
    }

    return mountInstance(instance.hostUid, hostElement, {
      instance,
      preserveSpec,
    });
  }

  // Save flow: update the real backing cell block first, remove only the overlay editor, then remap
  // against Roam's freshly rendered native table DOM. Never treat the edited <td> markup as source of truth.
  async function commitEdit(instance, { navigate = 0, focus = true } = {}) {
    const editing = instance.editing;
    if (!editing) {
      return;
    }

    if (editing.promise) {
      await editing.promise;
      return;
    }

    editing.promise = (async () => {
      const spec = editing.spec;
      const nextSpec = navigate ? getAdjacentSpec(instance, spec, navigate) : spec;
      const newValue = editing.input.value;

      try {
        if (newValue !== editing.initialValue) {
          await setCellValue(instance, spec, newValue);
          instance.editing = null;
          teardownEditingView(editing);
          await refreshInstance(instance, nextSpec);
          const restoredSpec = resolvePreservedSpec(instance, nextSpec);
          if (restoredSpec) {
            selectCell(instance, restoredSpec, { focus });
            if (navigate && focus) {
              await beginEdit(instance, restoredSpec);
            }
          }
          return;
        }

        instance.editing = null;
        teardownEditingView(editing);
        selectCell(instance, nextSpec, { focus });
        if (navigate && focus && !sameSpec(nextSpec, spec)) {
          await beginEdit(instance, nextSpec);
        }
      } catch (error) {
        instance.editing = null;
        teardownEditingView(editing);
        selectCell(instance, spec, { focus });
        console.warn('[builtin-editable-table] save failed', error);
        throw error;
      }
    })();

    try {
      await editing.promise;
    } finally {
      if (instance.editing === editing) {
        instance.editing.promise = null;
      }
    }
  }

  async function commitEditSafely(instance, options) {
    try {
      await commitEdit(instance, options);
    } catch (error) {
      console.warn('[builtin-editable-table] commit failed', error);
    }
  }

  async function handleEditBlur(instance) {
    await commitEditSafely(instance, { navigate: 0, focus: false });
    if (!instance.editing) {
      clearSelection(instance);
    }
  }

  async function handleEditKeyDown(instance, event) {
    event.stopPropagation();

    if (event.key === 'Enter') {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        await commitEditSafely(instance, { navigate: 0 });
      }
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      await commitEditSafely(instance, { navigate: event.shiftKey ? -1 : 1 });
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelEdit(instance);
    }
  }

  function handleEditMouseEvent(event) {
    event.stopPropagation();
  }

  async function setCellValue(instance, spec, value) {
    const state = instance.state;
    if (!state || !state.cellsByUid || !spec || !spec.cellUid) {
      throw new Error('Cell mapping is unavailable.');
    }

    const cell = state.cellsByUid.get(spec.cellUid);
    if (!cell) {
      throw new Error(`Cell ${spec.cellUid} not found.`);
    }

    await getApi().updateBlock({
      block: {
        uid: spec.cellUid,
        string: value,
      },
    });
  }

  // Roam native {{table}} in this graph is not stored as sibling row blocks.
  // Instead, each rendered table row corresponds to one root-to-leaf path under the host block.
  // Example: A -> B -> C -> D renders as one visible row with 4 cells, and shared prefixes can appear
  // in multiple rendered rows. Keep parser/mapping logic path-based unless fresh DOM evidence proves otherwise.
  function getNativeTablePathRows(hostBlock) {
    const rows = [];
    const roots = sortChildren(getChildren(hostBlock));

    function visit(block, path, depth) {
      if (!block || depth > MAX_NATIVE_TABLE_DEPTH) {
        return;
      }

      const nextPath = path.concat(block);
      const children = sortChildren(getChildren(block));
      if (children.length === 0) {
        rows.push(nextPath);
        return;
      }

      children.forEach((child) => {
        visit(child, nextPath, depth + 1);
      });
    }

    roots.forEach((root) => {
      visit(root, [], 0);
    });

    return rows;
  }

  function getNativeTablePathUid(pathBlocks, rowIndex) {
    const uid = pathBlocks.map((block) => getBlockUid(block)).filter(Boolean).join('>');
    return uid || `native-row-${rowIndex}`;
  }

  async function loadNativeTable(hostUid) {
    const host = await pullNativeTableTree(hostUid);
    if (!host) {
      throw new Error(`Host block ${hostUid} not found.`);
    }

    const hostString = (getBlockString(host) || '').trim();
    if (!TABLE_MARKERS.has(hostString)) {
      throw new Error(`Host block ${hostUid} is not a native table marker.`);
    }

    const rows = [];
    const cellsByUid = new Map();
    const rowPaths = getNativeTablePathRows(host);
    if (rowPaths.length === 0) {
      throw new Error('Native table has no leaf paths.');
    }

    const rowShapes = rowPaths.map((pathBlocks) => describeNativeTablePath(pathBlocks));

    rowPaths.forEach((pathBlocks, rowIndex) => {
      const rowUid = getNativeTablePathUid(pathBlocks, rowIndex);
      const rootUid = pathBlocks[0] ? getBlockUid(pathBlocks[0]) : '';
      const path = pathBlocks.map((cellBlock, colIndex) => {
        const parentBlock = colIndex > 0 ? pathBlocks[colIndex - 1] : host;
        const siblings = sortChildren(getChildren(parentBlock));
        const orderIndex = siblings.findIndex((item) => getBlockUid(item) === getBlockUid(cellBlock));
        return {
          uid: getBlockUid(cellBlock),
          string: getBlockString(cellBlock),
          rowUid,
          rowIndex,
          colIndex,
          parentUid: getBlockUid(parentBlock),
          orderIndex,
        };
      });

      const cells = path.map((cell) => ({ ...cell }));
      cells.forEach((cell) => {
        if (!cell.uid) {
          throw new Error(`Row ${rowUid || rowIndex} contains a cell without uid.`);
        }

        if (!cellsByUid.has(cell.uid)) {
          cellsByUid.set(cell.uid, cell);
        }
      });

      rows.push({
        uid: rowUid,
        rowIndex,
        rootUid,
        rootOrderIndex: path.length > 0 ? path[0].orderIndex : -1,
        path,
        cells,
      });
    });

    const profile = rows.map((row) => row.cells.length);
    debugLog('parsed native table state', {
      uid: hostUid,
      profile: formatProfile(profile),
      rowShapes: rowShapes.join(' | '),
    });

    return {
      hostUid,
      hostBlock: host,
      rows,
      cellsByUid,
      profile,
    };
  }

  function describeNativeTablePath(pathBlocks) {
    return pathBlocks.map((block) => getBlockUid(block) || '?').join(' -> ');
  }

  function findNativeTableElement(hostContainer, hostElement, state) {
    const expectedProfile = state.profile;
    const scopes = getSearchScopes(hostContainer, hostElement);
    const seenTables = new Set();

    for (const scope of scopes) {
      if (!scope || !scope.isConnected) {
        continue;
      }

      const matches = [];
      for (const tableElement of scope.querySelectorAll('table')) {
        if (!tableElement || seenTables.has(tableElement) || !isVisibleElement(tableElement)) {
          continue;
        }

        seenTables.add(tableElement);
        const renderedRows = collectRenderedTableRows(tableElement);
        const renderedProfile = renderedRows.map((row) => row.cells.length);
        if (!profilesMatch(expectedProfile, renderedProfile, { allowTrailingBlankCells: true })) {
          continue;
        }

        const hasUnsupportedSpans = renderedRows.some((row) => {
          return row.cells.some((cell) => {
            return (cell.colSpan && cell.colSpan > 1) || (cell.rowSpan && cell.rowSpan > 1);
          });
        });
        if (hasUnsupportedSpans) {
          continue;
        }

        matches.push(tableElement);
      }

      if (matches.length === 1) {
        return matches[0];
      }

      if (matches.length > 1) {
        debugLog('native table DOM match is ambiguous', {
          uid: state.hostUid,
          matches: matches.length,
          profile: formatProfile(expectedProfile),
        });
        return null;
      }
    }

    return null;
  }

  function getSearchScopes(hostContainer, hostElement) {
    const scopes = [];
    const childContainer = getDirectChildByClass(hostContainer, ['block-children', 'rm-block-children']);

    for (const scope of [childContainer, hostContainer, hostElement]) {
      if (scope && !scopes.includes(scope)) {
        scopes.push(scope);
      }
    }

    return scopes;
  }

  function buildCellMapping(tableElement, state) {
    const renderedRows = collectRenderedTableRows(tableElement);
    const renderedProfile = renderedRows.map((row) => row.cells.length);
    if (!profilesMatch(state.profile, renderedProfile, { allowTrailingBlankCells: true })) {
      return null;
    }

    const entries = [];
    const usedElements = new Set();

    for (let rowIndex = 0; rowIndex < state.rows.length; rowIndex += 1) {
      const stateRow = state.rows[rowIndex];
      const renderedRow = renderedRows[rowIndex];
      if (!stateRow || !renderedRow || renderedRow.cells.length < stateRow.cells.length) {
        return null;
      }

      for (let colIndex = 0; colIndex < stateRow.cells.length; colIndex += 1) {
        const stateCell = stateRow.cells[colIndex];
        const renderedCell = renderedRow.cells[colIndex];
        if (!stateCell || !stateCell.uid || !renderedCell) {
          return null;
        }

        if ((renderedCell.colSpan && renderedCell.colSpan > 1) || (renderedCell.rowSpan && renderedCell.rowSpan > 1)) {
          return null;
        }

        if (usedElements.has(renderedCell)) {
          return null;
        }

        usedElements.add(renderedCell);
        entries.push({
          element: renderedCell,
          cellUid: stateCell.uid,
          rowUid: stateRow.uid,
          rowIndex,
          colIndex,
        });
      }
    }

    return { entries };
  }

  function collectRenderedTableRows(tableElement) {
    const rows = [];

    for (const row of Array.from(tableElement.querySelectorAll('tr'))) {
      if (row.closest('table') !== tableElement || !isVisibleElement(row)) {
        continue;
      }

      const cells = Array.from(row.children).filter((cell) => {
        return /^(TD|TH)$/i.test(cell.tagName) && isVisibleElement(cell);
      });

      if (cells.length > 0) {
        rows.push({
          element: row,
          cells,
        });
      }
    }

    return rows;
  }

  function getRenderedCellText(cell) {
    if (!cell) {
      return '';
    }

    return cell.textContent || cell.innerText || '';
  }

  function profilesMatch(expected, actual, options = {}) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      return false;
    }

    const allowTrailingBlankCells = !!options.allowTrailingBlankCells;

    return expected.every((value, index) => {
      const actualValue = actual[index];
      if (!Number.isInteger(value) || !Number.isInteger(actualValue)) {
        return false;
      }
      if (allowTrailingBlankCells) {
        return actualValue >= value;
      }
      return value === actualValue;
    });
  }

  function buildNativeTablePullPattern(depth) {
    const fields = [':block/uid', ':block/string', ':block/order'];
    if (depth <= 0) {
      return `[${fields.join(' ')}]`;
    }
    return `[${fields.join(' ')} {:block/children ${buildNativeTablePullPattern(depth - 1)}}]`;
  }

  async function pullNativeTableTree(uid) {
    return getApi().pull(
      buildNativeTablePullPattern(MAX_NATIVE_TABLE_DEPTH),
      [':block/uid', uid]
    );
  }

  function getApi() {
    if (!window.roamAlphaAPI) {
      throw new Error('roamAlphaAPI is unavailable.');
    }
    return window.roamAlphaAPI;
  }

  function getBlockUid(block) {
    return block ? block[KEYS.uid] || '' : '';
  }

  function getBlockString(block) {
    return block ? block[KEYS.string] || '' : '';
  }

  function getChildren(block) {
    return block ? block[KEYS.children] || [] : [];
  }

  function sortChildren(children) {
    return (children || []).slice().sort((a, b) => {
      return (a[KEYS.order] || 0) - (b[KEYS.order] || 0);
    });
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const rects = typeof element.getClientRects === 'function' ? element.getClientRects() : null;
    if (rects && rects.length > 0) {
      return true;
    }

    if (typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }

    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  function normalizeHostElement(element) {
    if (!element || !element.isConnected) {
      return null;
    }

    const host = element.closest('.roam-block-container') || element.closest('.rm-block-main') || element.closest('[id^="block-input-"]') || element.closest('[data-block-uid]') || element.closest('[data-uid]') || element;
    return host && host.isConnected ? host : null;
  }

  function pickBestHostElement(nodes) {
    const normalized = (nodes || []).map(normalizeHostElement).filter(Boolean);
    for (const node of normalized) {
      if (isVisibleElement(node)) {
        return node;
      }
    }
    return normalized[0] || null;
  }

  function findElementsForUid(uid) {
    const escaped = escapeSelector(uid);
    const selectors = [
      `#block-input-${escaped}`,
      `[id="block-input-${uid}"]`,
      `[data-uid="${uid}"]`,
      `[data-block-uid="${uid}"]`,
    ];
    const nodes = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const host = normalizeHostElement(node);
        if (!host || seen.has(host)) {
          continue;
        }
        seen.add(host);
        nodes.push(host);
      }
    }

    return nodes;
  }

  function findElementForUid(uid) {
    return pickBestHostElement(findElementsForUid(uid));
  }


  function findHostContainer(element) {
    let current = element;
    while (current && current !== document.body) {
      if (current.classList && current.classList.contains('roam-block-container')) {
        return current;
      }
      if (getDirectChildByClass(current, ['block-children', 'rm-block-children'])) {
        return current;
      }
      current = current.parentElement;
    }

    return element ? (element.closest('.roam-block-container') || element.closest('[data-block-uid]') || element.closest('[data-uid]') || element) : null;
  }

  function getDirectChildByClass(element, classNames) {
    if (!element || !element.children) {
      return null;
    }

    return Array.from(element.children).find((child) => {
      return classNames.some((className) => child.classList && child.classList.contains(className));
    }) || null;
  }

  function escapeSelector(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function formatError(error) {
    if (!error) {
      return 'Unknown error';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error.message) {
      return error.message;
    }
    return String(error);
  }
})();
