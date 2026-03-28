(() => {
  'use strict';

  const PLUGIN_KEY = '__roamEditableTablePlugin';
  const STYLE_ID = 'roam-editable-table-style';
  const ROOT_CLASS = 'roam-editable-table-root';
  const HIDDEN_CLASS = 'roam-editable-table-hidden';
  const META_PREFIX = 'table-meta::';
  const ROWS_PREFIX = 'table-rows::';
  const MARKER_PATTERN = /^\s*\{\{(?:editable-table|\[\[editable-table\]\])\}\}\s*$/;
  const DEBUG = true;

  function debugLog(...args) {
    if (DEBUG) {
      console.log('[editable-table]', ...args);
    }
  }
  const KEYS = {
    uid: ':block/uid',
    string: ':block/string',
    children: ':block/children',
    order: ':block/order',
  };

  if (window[PLUGIN_KEY] && typeof window[PLUGIN_KEY].destroy === 'function') {
    window[PLUGIN_KEY].destroy();
  }

  // Keep one global plugin object so reloading this script can cleanly tear down the previous instance.
  const plugin = {
    initialized: false,
    observer: null,
    pollTimer: null,
    scanTimer: null,
    scanning: false,
    rescanQueued: false,
    instances: new Map(),
    markerCache: new Map(),
    markerCacheTtl: 5000,
    negativeMarkerCacheTtl: 2000,
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

  // Roam custom JS may run before roamAlphaAPI is ready, so initialization retries until the API exists.
  async function init() {
    if (plugin.initialized) {
      scheduleScan();
      return;
    }

    if (!window.roamAlphaAPI) {
      console.warn('[editable-table] roamAlphaAPI is not available yet.');
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

  function startPolling() {
    if (plugin.pollTimer) {
      clearInterval(plugin.pollTimer);
    }

    plugin.pollTimer = setInterval(() => {
      scheduleScan();
    }, 1500);
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
    plugin.markerCache.clear();

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
      .${ROOT_CLASS} {
        margin: 8px 0 8px 24px;
        font-family: inherit;
      }

      .${ROOT_CLASS} * {
        box-sizing: border-box;
      }

      .${ROOT_CLASS} .editable-table-shell {
        display: inline-block;
        min-width: 320px;
        max-width: 100%;
        border: 1px solid rgba(120, 120, 120, 0.35);
        border-radius: 8px;
        background: var(--bg-color, #fff);
        overflow: auto;
      }

      .${ROOT_CLASS} .editable-table-status {
        margin-bottom: 6px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.4;
      }

      .${ROOT_CLASS} .editable-table-status[data-kind="error"] {
        background: rgba(215, 58, 73, 0.1);
        color: #9f1d2a;
      }

      .${ROOT_CLASS} .editable-table-status[data-kind="warning"] {
        background: rgba(255, 190, 0, 0.14);
        color: #7a5901;
      }

      .${ROOT_CLASS} .editable-table-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 6px;
      }

      .${ROOT_CLASS} .editable-table-button {
        padding: 4px 10px;
        border: 1px solid rgba(120, 120, 120, 0.28);
        border-radius: 6px;
        background: var(--bg-color, #fff);
        font: inherit;
        font-size: 12px;
        line-height: 1.4;
        color: inherit;
        cursor: pointer;
      }

      .${ROOT_CLASS} .editable-table-button:hover:enabled {
        background: rgba(68, 132, 255, 0.08);
      }

      .${ROOT_CLASS} .editable-table-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .${ROOT_CLASS} table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      .${ROOT_CLASS} th,
      .${ROOT_CLASS} td {
        min-width: 96px;
        padding: 0;
        border: 1px solid rgba(120, 120, 120, 0.22);
        vertical-align: top;
        background: inherit;
      }

      .${ROOT_CLASS} th {
        background: rgba(125, 125, 125, 0.08);
      }

      .${ROOT_CLASS} [data-et-cell="true"] {
        position: relative;
        cursor: text;
        outline: none;
      }

      .${ROOT_CLASS} [data-et-cell="true"]::after {
        content: '';
        position: absolute;
        inset: 0;
        box-sizing: border-box;
        pointer-events: none;
        border: 2px solid transparent;
        z-index: 1;
      }

      .${ROOT_CLASS} [data-et-cell="true"]:focus::after {
        border-color: rgba(68, 132, 255, 0.38);
      }

      .${ROOT_CLASS} [data-et-cell="true"].is-selected::after {
        border-color: rgba(68, 132, 255, 0.48);
      }

      .${ROOT_CLASS} .editable-table-cell-content {
        min-height: 36px;
        padding: 8px 10px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .${ROOT_CLASS} .editable-table-input {
        display: block;
        width: 100%;
        min-height: 36px;
        padding: 8px 10px;
        border: 0;
        outline: none;
        background: #fff;
        font: inherit;
        color: inherit;
        box-sizing: border-box;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        resize: none;
        overflow: hidden;
      }

      .${ROOT_CLASS} .editable-table-loading,
      .${ROOT_CLASS} .editable-table-empty {
        padding: 8px 10px;
        font-size: 13px;
        color: rgba(80, 80, 80, 0.9);
      }

      .${ROOT_CLASS} .editable-table-row-error td {
        padding: 8px 10px;
        background: rgba(215, 58, 73, 0.08);
        color: #9f1d2a;
        font-size: 12px;
      }

      .${HIDDEN_CLASS} {
        display: none !important;
      }
    `;

    document.head.appendChild(style);
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
      attributeFilter: ['data-uid', 'id', 'class'],
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
        const visibleMarkers = new Set();
        const candidates = collectCandidateBlocks();
        const queryMarkerUids = new Set(await findMarkerBlockUids());
        const visibleMarkerHosts = collectVisibleMarkerTextHosts();
        debugLog('scan start', {
          candidates: candidates.size,
          queriedMarkers: queryMarkerUids.size,
          visibleMarkerHosts: visibleMarkerHosts.length,
          mounted: plugin.instances.size,
        });

        const unmatchedQueriedUids = [];
        for (const uid of queryMarkerUids) {
          const hostElement = candidates.get(uid) || findElementForUid(uid);
          if (hostElement) {
            candidates.set(uid, hostElement);
            continue;
          }
          unmatchedQueriedUids.push(uid);
        }

        for (const [index, uid] of unmatchedQueriedUids.entries()) {
          const hostElement = visibleMarkerHosts[index];
          if (!hostElement) {
            debugLog('queried marker has no visible host', { uid });
            continue;
          }
          candidates.set(uid, hostElement);
          debugLog('mapped queried marker to visible host', {
            queriedUid: uid,
            domUid: getUidFromElement(hostElement) || null,
          });
        }

        for (const uid of queryMarkerUids) {
          plugin.markerCache.set(uid, { isMarker: true, checkedAt: Date.now() });
        }

        for (const hostElement of visibleMarkerHosts) {
          const domUid = getUidFromElement(hostElement);
          if (domUid && !queryMarkerUids.has(domUid)) {
            plugin.markerCache.delete(domUid);
          }
        }

        for (const queriedUid of queryMarkerUids) {
          const existing = plugin.instances.get(queriedUid);
          if (existing && !candidates.has(queriedUid)) {
            const hostElement = findElementForUid(queriedUid) || visibleMarkerHosts[0] || null;
            if (hostElement) {
              candidates.set(queriedUid, hostElement);
            }
          }
        }

        for (const syntheticUid of Array.from(plugin.instances.keys())) {
          if (queryMarkerUids.has(syntheticUid)) {
            continue;
          }
          if (plugin.markerCache.has(syntheticUid) && !candidates.has(syntheticUid) && syntheticUid.includes('-body-outline-')) {
            const instance = plugin.instances.get(syntheticUid);
            if (instance) {
              cleanupInstance(instance);
              plugin.instances.delete(syntheticUid);
            }
            plugin.markerCache.delete(syntheticUid);
          }
        }

        const orderedCandidates = new Map();
        for (const uid of queryMarkerUids) {
          if (candidates.has(uid)) {
            orderedCandidates.set(uid, candidates.get(uid));
          }
        }
        for (const [uid, hostElement] of candidates.entries()) {
          if (!orderedCandidates.has(uid)) {
            orderedCandidates.set(uid, hostElement);
          }
        }

        for (const [uid, hostElement] of orderedCandidates.entries()) {
          const isMarker = queryMarkerUids.has(uid) || await isEditableTableHost(uid, hostElement);
          if (isMarker) {
            debugLog('marker visible', { uid });
          }
          if (!isMarker) {
            const existing = plugin.instances.get(uid);
            if (existing) {
              cleanupInstance(existing);
              plugin.instances.delete(uid);
            }
            continue;
          }

          visibleMarkers.add(uid);
          const existing = plugin.instances.get(uid);
          if (existing) {
            ensureRootPlacement(existing, hostElement);
            applyManagedVisibility(existing);
            continue;
          }

          await mountInstance(uid, hostElement);
        }

        for (const [uid, instance] of Array.from(plugin.instances.entries())) {
          const hostElement = candidates.get(uid) || findElementForUid(uid);
          if (!visibleMarkers.has(uid) || !hostElement) {
            cleanupInstance(instance);
            plugin.instances.delete(uid);
            continue;
          }

          ensureRootPlacement(instance, hostElement);
        }
      } while (plugin.rescanQueued);
    } catch (error) {
      console.error('[editable-table] scan failed', error);
    } finally {
      plugin.scanning = false;
    }
  }

  async function findMarkerBlockUids(allowedUids = []) {
    const api = getApi();
    const results = new Set();
    const markerStrings = ['{{editable-table}}', '{{[[editable-table]]}}'];
    const allowed = new Set((allowedUids || []).filter(Boolean));

    for (const marker of markerStrings) {
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
          if (!uid) {
            continue;
          }
          if (allowed.size && !allowed.has(uid)) {
            continue;
          }
          results.add(uid);
        }
      } catch (error) {
        console.warn('[editable-table] marker query failed', marker, error);
      }
    }

    return Array.from(results);
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

    const host = element.closest('.roam-block-container') || element.closest('.rm-block-main') || element.closest('[id^="block-input-"]') || element.closest('[data-uid]') || element;
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

  async function waitForElementForUid(uid, attempts = 10, delay = 150) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const element = findElementForUid(uid);
      if (element) {
        return element;
      }
      await sleep(delay);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function collectCandidateBlocks() {
    const selectors = [
      '[id^="block-input-"]',
      '.roam-block[data-uid]',
      '.roam-block-container[data-uid]',
      '.rm-block-text[data-uid]',
      '.rm-block-main [data-uid]',
    ];

    const nodes = document.querySelectorAll(selectors.join(', '));
    const map = new Map();

    for (const node of nodes) {
      const uid = getUidFromElement(node);
      const host = normalizeHostElement(node);
      if (!uid || !host || map.has(uid)) {
        continue;
      }
      if (!isVisibleElement(host)) {
        continue;
      }
      map.set(uid, host);
    }

    return map;
  }

  function parseUidFromBlockInputId(id) {
    if (typeof id !== 'string' || !id.startsWith('block-input-')) {
      return null;
    }

    const raw = id.slice('block-input-'.length);
    const match = raw.match(/([A-Za-z0-9_-]{9,})$/);
    return match ? match[1] : raw;
  }

  function getUidFromElement(element) {
    if (!element) {
      return null;
    }

    if (typeof element.id === 'string' && element.id.startsWith('block-input-')) {
      return parseUidFromBlockInputId(element.id);
    }

    const nestedInput = typeof element.querySelector === 'function'
      ? element.querySelector('[id^="block-input-"]')
      : null;
    if (nestedInput && typeof nestedInput.id === 'string' && nestedInput.id.startsWith('block-input-')) {
      return parseUidFromBlockInputId(nestedInput.id);
    }

    if (element.dataset && element.dataset.uid) {
      return element.dataset.uid;
    }

    const uidCarrier = element.closest('[data-uid]');
    if (uidCarrier && uidCarrier.dataset && uidCarrier.dataset.uid) {
      return uidCarrier.dataset.uid;
    }

    return null;
  }

  function extractMarkerTextCandidates(text) {
    const value = (text || '').trim();
    if (!value) {
      return [];
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    const candidates = [value, normalized];

    if (normalized === 'editable-table' || normalized === '[[editable-table]]') {
      candidates.push('{{editable-table}}', '{{[[editable-table]]}}');
    }

    return candidates;
  }

  function isEditableTableMarkerText(text) {
    return extractMarkerTextCandidates(text).some((candidate) => isEditableTableMarkerString(candidate));
  }

  function collectVisibleMarkerTextHosts() {
    const selectors = [
      '.roam-block-container',
      '.rm-block-main',
      '.roam-block',
      '.rm-block-text',
      '[id^="block-input-"]',
    ];
    const hosts = [];
    const seen = new Set();

    for (const node of document.querySelectorAll(selectors.join(', '))) {
      const host = normalizeHostElement(node);
      if (!host || seen.has(host) || !isVisibleElement(host)) {
        continue;
      }
      seen.add(host);

      const uid = getUidFromElement(host) || '';
      const text = getDomBlockString(uid, host);
      if (isEditableTableMarkerText(text)) {
        hosts.push(host);
      }
    }

    return hosts;
  }

  function getDomBlockString(uid, hostElement) {
    const candidates = [];
    if (hostElement) {
      candidates.push(hostElement);
    }
    for (const element of findElementsForUid(uid)) {
      if (!candidates.includes(element)) {
        candidates.push(element);
      }
    }

    for (const element of candidates) {
      if (!element || !element.isConnected) {
        continue;
      }

      const input = element.matches(`[id="block-input-${uid}"]`)
        ? element
        : element.querySelector(`[id="block-input-${uid}"]`);
      if (input) {
        for (const candidate of extractMarkerTextCandidates(typeof input.value === 'string' ? input.value : '')) {
          if (candidate) {
            return candidate;
          }
        }
        for (const candidate of extractMarkerTextCandidates(input.textContent || input.innerText || '')) {
          if (candidate) {
            return candidate;
          }
        }
      }

      const textSelectors = [
        '.rm-block-main .rm-block-text',
        '.rm-block-text',
        '.bp3-popover-target',
        '.rm-bullet__inner + div',
        '[data-link-title="editable-table"]',
      ];

      for (const selector of textSelectors) {
        const textNode = element.matches(selector) ? element : element.querySelector(selector);
        if (!textNode) {
          continue;
        }
        for (const candidate of extractMarkerTextCandidates(textNode.textContent || textNode.innerText || '')) {
          if (candidate) {
            return candidate;
          }
        }
      }

      for (const candidate of extractMarkerTextCandidates(element.textContent || element.innerText || '')) {
        if (candidate) {
          return candidate;
        }
      }
    }

    return '';
  }

  async function isEditableTableHost(uid, hostElement = null) {
    const now = Date.now();
    const cached = plugin.markerCache.get(uid);
    if (cached) {
      const ttl = cached.isMarker ? plugin.markerCacheTtl : plugin.negativeMarkerCacheTtl;
      if (now - cached.checkedAt < ttl) {
        return cached.isMarker;
      }
    }

    const domString = getDomBlockString(uid, hostElement);
    if (isEditableTableMarkerString(domString)) {
      plugin.markerCache.set(uid, { isMarker: true, checkedAt: now });
      return true;
    }

    try {
      const block = await pullBlock(uid);
      const isMarker = isEditableTableMarkerString(getBlockString(block));
      plugin.markerCache.set(uid, { isMarker, checkedAt: now });
      return isMarker;
    } catch (error) {
      console.warn('[editable-table] failed to inspect block', uid, error);
      plugin.markerCache.set(uid, { isMarker: false, checkedAt: now });
      return false;
    }
  }

  // Mounting loads the current table state, renders the managed UI, and hides the backing Roam child blocks.
  async function mountInstance(hostUid, hostElement) {
    debugLog('mount start', { uid: hostUid, hasHostElement: !!hostElement });
    let instance = plugin.instances.get(hostUid);
    if (!instance) {
      instance = createInstance(hostUid);
      plugin.instances.set(hostUid, instance);
    }

    if (instance.loading) {
      ensureRootPlacement(instance, hostElement);
      return instance;
    }

    ensureRootPlacement(instance, hostElement);
    renderLoading(instance);
    instance.loading = true;

    try {
      instance.state = await loadTable(hostUid);
      const latestHostElement = findElementForUid(hostUid) || hostElement;
      if (latestHostElement) {
        ensureRootPlacement(instance, latestHostElement);
      }
      instance.loading = false;
      renderInstance(instance);
      applyManagedVisibility(instance);
      debugLog('mount success', { uid: hostUid, rows: instance.state ? instance.state.rows.length : 0, cols: instance.state ? instance.state.cols.length : 0 });
      scheduleScan();
    } catch (error) {
      instance.loading = false;
      instance.message = formatError(error);
      renderInstance(instance);
      console.error('[editable-table] failed to mount table', hostUid, error);
    }

    return instance;
  }

  // Each visible marker block gets one instance that owns UI state and event handlers.
  function createInstance(hostUid) {
    const root = document.createElement('div');
    root.className = ROOT_CLASS;
    root.dataset.hostUid = hostUid;

    const instance = {
      hostUid,
      root,
      hostElement: null,
      hostContainer: null,
      childContainer: null,
      hiddenNodes: [],
      state: null,
      selected: null,
      editing: null,
      loading: false,
      mutating: false,
      message: '',
    };

    root.addEventListener('mousedown', (event) => handleRootMouseDown(instance, event));
    root.addEventListener('click', (event) => {
      void handleRootClick(instance, event);
    });
    root.addEventListener('dblclick', (event) => handleRootDoubleClick(instance, event));
    root.addEventListener('keydown', (event) => handleRootKeyDown(instance, event));

    return instance;
  }

  function cleanupInstance(instance) {
    clearHiddenNodes(instance);

    if (instance.root && instance.root.parentElement) {
      instance.root.remove();
    }

    instance.hostElement = null;
    instance.hostContainer = null;
    instance.childContainer = null;
    instance.selected = null;
    instance.editing = null;
  }

  function ensureRootPlacement(instance, hostElement) {
    if (!hostElement || !hostElement.isConnected) {
      debugLog('placement skipped', { uid: instance.hostUid, reason: 'missing-host' });
      return;
    }

    const hostContainer = findHostContainer(hostElement);
    if (!hostContainer) {
      debugLog('placement skipped', { uid: instance.hostUid, reason: 'missing-container' });
      return;
    }

    debugLog('placement target', {
      uid: instance.hostUid,
      hostTag: hostElement.tagName,
      containerTag: hostContainer.tagName,
      hasChildContainer: !!getDirectChildByClass(hostContainer, ['block-children', 'rm-block-children']),
    });

    instance.hostElement = hostElement;
    instance.hostContainer = hostContainer;

    const childContainer = getDirectChildByClass(hostContainer, ['block-children', 'rm-block-children']);
    instance.childContainer = childContainer || null;

    if (childContainer && isVisibleElement(childContainer)) {
      if (instance.root.parentElement !== childContainer) {
        childContainer.insertBefore(instance.root, childContainer.firstChild);
      } else if (childContainer.firstChild !== instance.root) {
        childContainer.insertBefore(instance.root, childContainer.firstChild);
      }
      return;
    }

    const blockMain = getDirectChildByClass(hostContainer, ['rm-block-main', 'roam-block-main']);
    if (instance.root.parentElement !== hostContainer) {
      if (blockMain && blockMain.nextSibling) {
        hostContainer.insertBefore(instance.root, blockMain.nextSibling);
      } else {
        hostContainer.appendChild(instance.root);
      }
    }
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

    return element.closest('.roam-block-container') || element.closest('[data-uid]') || element;
  }

  function getDirectChildByClass(element, classNames) {
    if (!element || !element.children) {
      return null;
    }

    return Array.from(element.children).find((child) => {
      return classNames.some((className) => child.classList && child.classList.contains(className));
    }) || null;
  }

  function applyManagedVisibility(instance) {
    clearHiddenNodes(instance);

    const state = instance.state;
    const scope = instance.childContainer || instance.hostContainer;
    if (!state || !scope) {
      return;
    }

    const managedUids = new Set([state.metaUid, state.rowsUid]);
    for (const row of state.rows || []) {
      managedUids.add(row.uid);
    }

    for (const uid of managedUids) {
      if (!uid) {
        continue;
      }

      const selector = `[data-uid="${escapeSelector(uid)}"], #block-input-${escapeSelector(uid)}`;
      const matches = scope.querySelectorAll(selector);
      for (const node of matches) {
        if (instance.root.contains(node)) {
          continue;
        }
        const blockNode = findRenderableBlockNode(node, scope);
        if (!blockNode || blockNode === instance.root || instance.root.contains(blockNode)) {
          continue;
        }
        if (!instance.hiddenNodes.includes(blockNode)) {
          blockNode.classList.add(HIDDEN_CLASS);
          instance.hiddenNodes.push(blockNode);
        }
      }
    }
  }

  function clearHiddenNodes(instance) {
    for (const node of instance.hiddenNodes || []) {
      if (node && node.classList) {
        node.classList.remove(HIDDEN_CLASS);
      }
    }
    instance.hiddenNodes = [];
  }

  function findRenderableBlockNode(node, scope) {
    let current = node;
    while (current && current !== scope) {
      if (current.classList && (current.classList.contains('roam-block-container') || current.classList.contains('rm-block-main') || current.classList.contains('roam-block'))) {
        return current;
      }
      current = current.parentElement;
    }

    return node;
  }

  function renderLoading(instance) {
    instance.root.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'editable-table-loading';
    loading.textContent = 'Loading editable table…';
    instance.root.appendChild(loading);
  }

  function appendActionButton(toolbar, action, label, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editable-table-button';
    button.dataset.etAction = action;
    button.textContent = label;
    button.disabled = !!disabled;
    toolbar.appendChild(button);
  }

  // Toolbar enable/disable state depends on the current selection, row error state, and ongoing mutations.
  function updateToolbarState(instance) {
    if (!instance || !instance.root || !instance.state) {
      return;
    }

    const state = instance.state;
    const selectedRowUid = getSelectedRowUid(instance);
    const selectedColIndex = getSelectedColumnIndex(instance);
    const editableRowCount = state.rows.filter((row) => !row.error).length;
    const actionsDisabled = instance.loading || instance.mutating;
    const columnActionsDisabled = actionsDisabled || state.rowErrors.length > 0;

    const nextDisabledState = {
      'add-row': actionsDisabled,
      'delete-row': actionsDisabled || !selectedRowUid || editableRowCount <= 1,
      'add-column': columnActionsDisabled,
      'delete-column': columnActionsDisabled || selectedColIndex < 0 || selectedColIndex >= state.cols.length || state.cols.length <= 1,
    };

    for (const [action, disabled] of Object.entries(nextDisabledState)) {
      const button = instance.root.querySelector(`[data-et-action="${action}"]`);
      if (button) {
        button.disabled = !!disabled;
      }
    }
  }

  // Rebuild the table UI from instance.state so persistence stays the single source of truth.
  function renderInstance(instance) {
    const state = instance.state;
    instance.root.innerHTML = '';

    if (!state) {
      const empty = document.createElement('div');
      empty.className = 'editable-table-empty';
      empty.textContent = instance.message || 'Editable table is unavailable.';
      instance.root.appendChild(empty);
      return;
    }

    const notices = [];
    if (instance.message) {
      notices.push({ kind: 'error', text: instance.message });
    }
    if (state.metaError) {
      notices.push({ kind: 'warning', text: `Meta parse failed: ${state.metaError}` });
    }
    if (state.rowErrors.length) {
      notices.push({
        kind: 'warning',
        text: `${state.rowErrors.length} row(s) contain invalid JSON and were left unchanged. Column add/delete is disabled until they are fixed.`,
      });
    }

    for (const notice of notices) {
      const banner = document.createElement('div');
      banner.className = 'editable-table-status';
      banner.dataset.kind = notice.kind;
      banner.textContent = notice.text;
      instance.root.appendChild(banner);
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'editable-table-toolbar';

    const selectedRowUid = getSelectedRowUid(instance);
    const selectedColIndex = getSelectedColumnIndex(instance);
    const editableRowCount = state.rows.filter((row) => !row.error).length;
    const actionsDisabled = instance.loading || instance.mutating;
    const columnActionsDisabled = actionsDisabled || state.rowErrors.length > 0;

    appendActionButton(toolbar, 'add-row', 'Add row', actionsDisabled);
    appendActionButton(toolbar, 'delete-row', 'Delete row', actionsDisabled || !selectedRowUid || editableRowCount <= 1);
    appendActionButton(toolbar, 'add-column', 'Add column', columnActionsDisabled);
    appendActionButton(
      toolbar,
      'delete-column',
      'Delete column',
      columnActionsDisabled || selectedColIndex < 0 || selectedColIndex >= state.cols.length || state.cols.length <= 1
    );

    instance.root.appendChild(toolbar);

    const shell = document.createElement('div');
    shell.className = 'editable-table-shell';
    const table = document.createElement('table');
    table.setAttribute('role', 'grid');
    table.dataset.hostUid = instance.hostUid;

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    state.cols.forEach((col, colIndex) => {
      const th = document.createElement('th');
      th.tabIndex = 0;
      th.dataset.etCell = 'true';
      th.dataset.kind = 'header';
      th.dataset.colIndex = String(colIndex);
      const content = document.createElement('div');
      content.className = 'editable-table-cell-content';
      content.textContent = col.label || defaultColumnLabel(colIndex);
      th.appendChild(content);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of state.rows) {
      if (row.error) {
        const tr = document.createElement('tr');
        tr.className = 'editable-table-row-error';
        const td = document.createElement('td');
        td.colSpan = Math.max(1, state.cols.length);
        td.textContent = `Row ${row.uid} JSON parse failed: ${row.error}`;
        tr.appendChild(td);
        tbody.appendChild(tr);
        continue;
      }

      const tr = document.createElement('tr');
      row.visibleCells.forEach((value, colIndex) => {
        const td = document.createElement('td');
        td.tabIndex = 0;
        td.dataset.etCell = 'true';
        td.dataset.kind = 'body';
        td.dataset.rowUid = row.uid;
        td.dataset.colIndex = String(colIndex);
        const content = document.createElement('div');
        content.className = 'editable-table-cell-content';
        content.textContent = value;
        td.appendChild(content);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    shell.appendChild(table);
    instance.root.appendChild(shell);

    if (instance.selected) {
      selectCell(instance, instance.selected, { focus: false, scroll: false });
    }
  }

  // Prevent mousedown-driven blur from consuming the first click when switching cells or pressing toolbar buttons.
  function handleRootMouseDown(instance, event) {
    const actionButton = event.target.closest('[data-et-action]');
    if (actionButton && instance.root.contains(actionButton)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.target.closest('input, textarea, button')) {
      event.stopPropagation();
      return;
    }

    const cell = event.target.closest('[data-et-cell="true"]');
    if (cell && instance.root.contains(cell)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // Clicks either route to toolbar actions or select-and-edit a cell in one step.
  async function handleRootClick(instance, event) {
    event.stopPropagation();

    const actionButton = event.target.closest('[data-et-action]');
    if (actionButton && instance.root.contains(actionButton)) {
      event.preventDefault();
      if (actionButton.disabled || instance.loading || instance.mutating) {
        return;
      }
      if (instance.editing) {
        await waitForEditCompletion(instance);
      }
      await runToolbarAction(instance, actionButton.dataset.etAction || '');
      return;
    }

    const cell = event.target.closest('[data-et-cell="true"]');
    if (!cell || !instance.root.contains(cell)) {
      return;
    }

    const spec = specFromCell(cell);
    if (!spec) {
      return;
    }

    if (instance.editing) {
      if (sameSpec(instance.editing.spec, spec)) {
        return;
      }
      await waitForEditCompletion(instance);
    }

    selectCell(instance, spec);
    await beginEdit(instance, spec);
  }

  async function runToolbarAction(instance, action) {
    if (!action) {
      return;
    }

    switch (action) {
      case 'add-row':
        await addRow(instance);
        return;
      case 'delete-row':
        await deleteSelectedRow(instance);
        return;
      case 'add-column':
        await addColumn(instance);
        return;
      case 'delete-column':
        await deleteSelectedColumn(instance);
        return;
      default:
        return;
    }
  }

  // Structural changes are serialized here so add/delete row/column operations do not overlap.
  async function runMutation(instance, work) {
    if (!instance || instance.mutating) {
      return;
    }

    instance.mutating = true;
    try {
      await work();
      instance.message = '';
    } catch (error) {
      instance.message = `Update failed: ${formatError(error)}`;
      console.error('[editable-table] structure update failed', error);
    } finally {
      instance.mutating = false;
      renderInstance(instance);
      applyManagedVisibility(instance);
    }
  }

  async function reloadInstanceState(instance) {
    instance.state = await loadTable(instance.hostUid);
    const latestHostElement = findElementForUid(instance.hostUid) || instance.hostElement;
    if (latestHostElement) {
      ensureRootPlacement(instance, latestHostElement);
    }
  }

  function getSelectedRowUid(instance) {
    return instance && instance.selected && instance.selected.kind === 'body' && instance.selected.rowUid
      ? instance.selected.rowUid
      : '';
  }

  function getSelectedColumnIndex(instance) {
    return instance && instance.selected && Number.isInteger(instance.selected.colIndex)
      ? instance.selected.colIndex
      : -1;
  }

  function buildMetaForSave(state) {
    return {
      version: state && Number.isInteger(state.version) ? state.version : 1,
      cols: (state && Array.isArray(state.cols) ? state.cols : []).map((item, index) => ({
        id: item && typeof item.id === 'string' && item.id ? item.id : `c${index + 1}`,
        label: item && typeof item.label === 'string' ? item.label : '',
      })),
    };
  }

  function generateColumnId(cols) {
    const existing = new Set((cols || []).map((col) => col && col.id).filter(Boolean));
    let index = (cols || []).length + 1;
    while (existing.has(`c${index}`)) {
      index += 1;
    }
    return `c${index}`;
  }

  async function addRow(instance) {
    await runMutation(instance, async () => {
      const state = instance.state;
      const selected = instance.selected;
      if (!state) {
        throw new Error('Table state is not loaded.');
      }

      const selectedRowIndex = selected && selected.kind === 'body'
        ? state.rows.findIndex((row) => row.uid === selected.rowUid)
        : -1;
      const insertIndex = selectedRowIndex >= 0 ? selectedRowIndex + 1 : state.rows.length;
      const selectedColIndex = selected && Number.isInteger(selected.colIndex) ? selected.colIndex : 0;
      const blankRow = Array(state.cols.length).fill('');
      const newRowUid = await createChildBlock(state.rowsUid, insertIndex, JSON.stringify(blankRow));
      await reloadInstanceState(instance);

      instance.selected = {
        kind: 'body',
        rowUid: newRowUid,
        colIndex: Math.max(0, Math.min(selectedColIndex, Math.max(0, instance.state.cols.length - 1))),
      };
    });
  }

  async function deleteSelectedRow(instance) {
    await runMutation(instance, async () => {
      const state = instance.state;
      const selected = instance.selected;
      if (!state) {
        throw new Error('Table state is not loaded.');
      }
      if (!selected || selected.kind !== 'body' || !selected.rowUid) {
        return;
      }

      const editableRows = state.rows.filter((row) => !row.error);
      if (editableRows.length <= 1) {
        return;
      }

      const rowIndex = editableRows.findIndex((row) => row.uid === selected.rowUid);
      if (rowIndex === -1) {
        return;
      }

      const nextRow = editableRows[rowIndex + 1] || editableRows[rowIndex - 1] || null;
      const nextColIndex = Math.max(0, Math.min(selected.colIndex, Math.max(0, state.cols.length - 1)));
      await deleteBlock(selected.rowUid);
      await reloadInstanceState(instance);

      instance.selected = nextRow
        ? { kind: 'body', rowUid: nextRow.uid, colIndex: nextColIndex }
        : { kind: 'header', colIndex: Math.min(nextColIndex, Math.max(0, (instance.state?.cols.length || 1) - 1)) };
    });
  }

  async function addColumn(instance) {
    await runMutation(instance, async () => {
      const state = instance.state;
      const selected = instance.selected;
      if (!state) {
        throw new Error('Table state is not loaded.');
      }
      if (state.rowErrors.length) {
        return;
      }

      const selectedColIndex = getSelectedColumnIndex(instance);
      const insertIndex = selectedColIndex >= 0 ? selectedColIndex + 1 : state.cols.length;
      const nextCols = state.cols.slice();
      nextCols.splice(insertIndex, 0, {
        id: generateColumnId(state.cols),
        label: defaultColumnLabel(nextCols.length - 1),
      });
      state.cols = nextCols;

      for (const row of state.rows) {
        if (row.error) {
          continue;
        }
        const rawCells = Array.isArray(row.rawCells) ? row.rawCells.slice() : [];
        rawCells.splice(insertIndex, 0, '');
        row.rawCells = rawCells;
        row.visibleCells = normalizeVisibleCells(rawCells, state.cols.length);
        await saveRow(row.uid, rawCells);
      }

      await saveMeta(state.metaUid, buildMetaForSave(state));
      await reloadInstanceState(instance);
      instance.selected = selected && selected.kind === 'body' && selected.rowUid
        ? { kind: 'body', rowUid: selected.rowUid, colIndex: insertIndex }
        : { kind: 'header', colIndex: insertIndex };
    });
  }

  async function deleteSelectedColumn(instance) {
    await runMutation(instance, async () => {
      const state = instance.state;
      const selectedColIndex = getSelectedColumnIndex(instance);
      const selected = instance.selected;
      if (!state) {
        throw new Error('Table state is not loaded.');
      }
      if (state.rowErrors.length || state.cols.length <= 1 || selectedColIndex < 0 || selectedColIndex >= state.cols.length) {
        return;
      }

      state.cols = state.cols.filter((_, index) => index !== selectedColIndex);
      for (const row of state.rows) {
        if (row.error) {
          continue;
        }
        const rawCells = Array.isArray(row.rawCells) ? row.rawCells.slice() : [];
        rawCells.splice(selectedColIndex, 1);
        row.rawCells = rawCells;
        row.visibleCells = normalizeVisibleCells(rawCells, state.cols.length);
        await saveRow(row.uid, rawCells);
      }

      await saveMeta(state.metaUid, buildMetaForSave(state));
      await reloadInstanceState(instance);
      const nextColIndex = Math.max(0, Math.min(selectedColIndex, instance.state.cols.length - 1));
      instance.selected = selected && selected.kind === 'body' && selected.rowUid
        ? { kind: 'body', rowUid: selected.rowUid, colIndex: nextColIndex }
        : { kind: 'header', colIndex: nextColIndex };
    });
  }

  async function deleteBlock(uid) {
    await getApi().deleteBlock({
      block: {
        uid,
      },
    });
  }

  async function waitForEditCompletion(instance) {
    if (!instance.editing) {
      return;
    }

    if (instance.editing.promise) {
      await instance.editing.promise;
      return;
    }

    await commitEdit(instance, { navigate: 0 });
  }

  function handleRootDoubleClick(instance, event) {
    event.stopPropagation();
    const cell = event.target.closest('[data-et-cell="true"]');
    if (!cell || !instance.root.contains(cell)) {
      return;
    }

    const spec = specFromCell(cell);
    if (!spec) {
      return;
    }

    void beginEdit(instance, spec);
  }

  function handleRootKeyDown(instance, event) {
    if (!instance.root.contains(event.target)) {
      return;
    }

    if (event.target.closest('[data-et-action], button')) {
      return;
    }

    if (!event.target.closest('[data-et-cell="true"], textarea, input')) {
      return;
    }

    if (instance.editing) {
      event.stopPropagation();
      return;
    }

    if (event.key === 'Enter' && instance.selected) {
      event.preventDefault();
      event.stopPropagation();
      void beginEdit(instance, instance.selected);
    }

    if (event.key === 'Tab' && instance.selected) {
      event.preventDefault();
      event.stopPropagation();
      const nextSpec = getAdjacentSpec(instance, instance.selected, event.shiftKey ? -1 : 1);
      selectCell(instance, nextSpec);
    }
  }

  function specFromCell(cell) {
    if (!cell || !cell.dataset || !cell.dataset.kind) {
      return null;
    }

    const colIndex = Number(cell.dataset.colIndex);
    if (!Number.isInteger(colIndex)) {
      return null;
    }

    if (cell.dataset.kind === 'header') {
      return { kind: 'header', colIndex };
    }

    if (cell.dataset.kind === 'body' && cell.dataset.rowUid) {
      return { kind: 'body', rowUid: cell.dataset.rowUid, colIndex };
    }

    return null;
  }

  function sameSpec(a, b) {
    if (!a || !b) {
      return false;
    }

    return a.kind === b.kind && a.rowUid === b.rowUid && a.colIndex === b.colIndex;
  }

  function selectCell(instance, spec, options = {}) {
    instance.selected = spec;

    for (const node of instance.root.querySelectorAll('[data-et-cell="true"]')) {
      node.classList.remove('is-selected');
    }

    const cell = findCellElement(instance, spec);
    updateToolbarState(instance);
    if (!cell) {
      return;
    }

    cell.classList.add('is-selected');

    const shouldFocus = options.focus !== false;
    const shouldScroll = options.scroll !== false;

    if (shouldFocus) {
      cell.focus({ preventScroll: !shouldScroll });
    }
  }

  function findCellElement(instance, spec) {
    if (!spec) {
      return null;
    }

    if (spec.kind === 'header') {
      return instance.root.querySelector(`[data-et-cell="true"][data-kind="header"][data-col-index="${spec.colIndex}"]`);
    }

    return instance.root.querySelector(`[data-et-cell="true"][data-kind="body"][data-row-uid="${escapeSelector(spec.rowUid)}"][data-col-index="${spec.colIndex}"]`);
  }

  function autoSizeEditInput(input) {
    if (!input || input.tagName !== 'TEXTAREA') {
      return;
    }

    input.style.height = 'auto';
    input.style.height = `${Math.max(36, input.scrollHeight)}px`;
  }

  // Enter edit mode by replacing one rendered cell with a textarea bound to the same persisted value.
  async function beginEdit(instance, spec) {
    if (!instance.state || instance.loading) {
      return;
    }

    if (instance.editing) {
      if (sameSpec(instance.editing.spec, spec)) {
        return;
      }
      await commitEdit(instance, { navigate: 0 });
    }

    const cell = findCellElement(instance, spec);
    if (!cell) {
      return;
    }

    const initialValue = getCellValue(instance.state, spec);
    if (typeof initialValue !== 'string') {
      return;
    }

    instance.message = '';
    instance.selected = spec;

    cell.classList.add('is-selected');
    cell.innerHTML = '';

    const input = document.createElement('textarea');
    input.className = 'editable-table-input';
    input.value = initialValue;
    input.rows = 1;
    input.autocomplete = 'off';
    input.spellcheck = false;

    instance.editing = {
      spec,
      input,
      initialValue,
      closing: false,
      promise: null,
    };

    input.addEventListener('keydown', (event) => {
      void handleEditKeyDown(instance, event);
    });

    input.addEventListener('input', () => {
      autoSizeEditInput(input);
    });

    input.addEventListener('blur', () => {
      void handleEditBlur(instance);
    });

    input.addEventListener('mousedown', handleEditMouseEvent);
    input.addEventListener('click', handleEditMouseEvent);

    cell.appendChild(input);
    autoSizeEditInput(input);
    input.focus({ preventScroll: true });
    const caretPosition = input.value.length;
    input.setSelectionRange(caretPosition, caretPosition);
  }

  function cancelEdit(instance) {
    if (!instance.editing) {
      return;
    }

    const spec = instance.editing.spec;
    instance.editing = null;
    renderInstance(instance);
    selectCell(instance, spec);
  }

  // Save the edited value back into meta or row JSON, then optionally move selection with Tab/Shift+Tab.
  async function commitEdit(instance, { navigate = 0 } = {}) {
    const editing = instance.editing;
    if (!editing) {
      return;
    }

    if (editing.promise) {
      await editing.promise;
      return;
    }

    editing.closing = true;
    editing.promise = (async () => {
      const spec = editing.spec;
      const nextSpec = navigate ? getAdjacentSpec(instance, spec, navigate) : spec;
      const newValue = editing.input.value;

      try {
        if (newValue !== editing.initialValue) {
          await setCellValue(instance, spec, newValue);
        }
        instance.message = '';
      } catch (error) {
        editing.closing = false;
        instance.editing = null;
        instance.message = `Save failed: ${formatError(error)}`;
        renderInstance(instance);
        selectCell(instance, spec);
        throw error;
      }

      instance.editing = null;
      renderInstance(instance);

      if (nextSpec) {
        selectCell(instance, nextSpec);
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
      console.warn('[editable-table] commit failed', error);
    }
  }

  async function handleEditBlur(instance) {
    await commitEditSafely(instance, { navigate: 0 });
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

  function getAdjacentSpec(instance, spec, delta) {
    const cells = Array.from(instance.root.querySelectorAll('[data-et-cell="true"]'));
    const currentIndex = cells.findIndex((cell) => sameSpec(specFromCell(cell), spec));
    if (currentIndex === -1) {
      return spec;
    }

    const nextIndex = currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= cells.length) {
      return spec;
    }

    return specFromCell(cells[nextIndex]) || spec;
  }

  function getCellValue(state, spec) {
    if (spec.kind === 'header') {
      return (state.cols[spec.colIndex] && state.cols[spec.colIndex].label) || '';
    }

    const row = state.rows.find((item) => item.uid === spec.rowUid);
    if (!row || row.error) {
      return '';
    }

    return row.visibleCells[spec.colIndex] || '';
  }

  async function setCellValue(instance, spec, value) {
    const state = instance.state;
    if (!state) {
      throw new Error('Table state is not loaded.');
    }

    if (spec.kind === 'header') {
      const col = state.cols[spec.colIndex];
      if (!col) {
        throw new Error('Column not found.');
      }
      col.label = value;
      await saveMeta(state.metaUid, {
        version: state.version || 1,
        cols: state.cols.map((item, index) => ({
          id: item.id || `c${index + 1}`,
          label: typeof item.label === 'string' ? item.label : '',
        })),
      });
      return;
    }

    const row = state.rows.find((item) => item.uid === spec.rowUid);
    if (!row || row.error) {
      throw new Error('Row is not editable.');
    }

    const rawCells = Array.isArray(row.rawCells) ? row.rawCells.slice() : [];
    while (rawCells.length <= spec.colIndex) {
      rawCells.push('');
    }
    rawCells[spec.colIndex] = value;

    row.rawCells = rawCells;
    row.visibleCells = normalizeVisibleCells(rawCells, state.cols.length);
    await saveRow(row.uid, rawCells);
  }

  // Read the managed child blocks, parse meta/rows, and keep broken rows isolated instead of failing the whole table.
  async function loadTable(hostUid) {
    const host = await ensureTableSchema(hostUid);
    if (!host) {
      throw new Error(`Host block ${hostUid} not found.`);
    }

    const children = sortChildren(getChildren(host));
    const metaBlock = children.find((child) => isMetaBlockString(getBlockString(child)));
    const rowsBlock = children.find((child) => isRowsBlockString(getBlockString(child)));

    if (!metaBlock || !rowsBlock) {
      throw new Error('Managed table blocks are missing.');
    }

    let parsedMeta = null;
    let metaError = '';
    let cols = defaultCols();
    let version = 1;

    try {
      parsedMeta = parseMeta(getBlockString(metaBlock));
      cols = parsedMeta.cols;
      version = parsedMeta.version;
    } catch (error) {
      metaError = formatError(error);
      cols = defaultCols();
      version = 1;
    }

    const rows = [];
    const rowErrors = [];
    const rowBlocks = sortChildren(getChildren(rowsBlock));
    for (const rowBlock of rowBlocks) {
      const rowUid = getBlockUid(rowBlock);
      try {
        const rawCells = parseRow(getBlockString(rowBlock));
        rows.push({
          uid: rowUid,
          rawCells,
          visibleCells: normalizeVisibleCells(rawCells, cols.length),
          error: '',
        });
      } catch (error) {
        const message = formatError(error);
        rowErrors.push({ uid: rowUid, error: message });
        rows.push({
          uid: rowUid,
          rawCells: [],
          visibleCells: normalizeVisibleCells([], cols.length),
          error: message,
        });
      }
    }

    return {
      hostUid,
      metaUid: getBlockUid(metaBlock),
      rowsUid: getBlockUid(rowsBlock),
      version,
      cols,
      rows,
      metaError,
      rowErrors,
    };
  }

  // Create the backing Roam block schema on first use; 3x3 is only the initial seed, not a fixed table size.
  async function ensureTableSchema(hostUid) {
    let host = await pullTableTree(hostUid);
    if (!host) {
      return null;
    }

    let children = sortChildren(getChildren(host));
    let metaBlock = children.find((child) => isMetaBlockString(getBlockString(child)));
    let rowsBlock = children.find((child) => isRowsBlockString(getBlockString(child)));
    let changed = false;

    if (!metaBlock) {
      await createChildBlock(hostUid, 0, `table-meta:: ${JSON.stringify(defaultMeta())}`);
      changed = true;
    }

    if (!rowsBlock) {
      await createChildBlock(hostUid, 1, ROWS_PREFIX);
      changed = true;
    }

    if (changed) {
      host = await pullTableTree(hostUid);
      children = sortChildren(getChildren(host));
      metaBlock = children.find((child) => isMetaBlockString(getBlockString(child)));
      rowsBlock = children.find((child) => isRowsBlockString(getBlockString(child)));
    }

    if (!rowsBlock) {
      return host;
    }

    const rowBlocks = sortChildren(getChildren(rowsBlock));
    if (rowBlocks.length === 0) {
      const colCount = (() => {
        try {
          return parseMeta(getBlockString(metaBlock)).cols.length;
        } catch (error) {
          return defaultCols().length;
        }
      })();

      for (let index = 0; index < 3; index += 1) {
        await createChildBlock(getBlockUid(rowsBlock), index, JSON.stringify(Array(colCount).fill('')));
      }
      host = await pullTableTree(hostUid);
    }

    return host;
  }

  function defaultMeta() {
    return {
      version: 1,
      cols: defaultCols(),
    };
  }

  function defaultCols() {
    return [0, 1, 2].map((index) => ({
      id: `c${index + 1}`,
      label: defaultColumnLabel(index),
    }));
  }

  function defaultColumnLabel(index) {
    return String.fromCharCode(65 + (index % 26));
  }

  function parseMeta(blockString) {
    if (!isMetaBlockString(blockString)) {
      throw new Error('Meta block prefix is missing.');
    }

    const json = blockString.slice(blockString.indexOf(META_PREFIX) + META_PREFIX.length).trim();
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cols) || parsed.cols.length === 0) {
      throw new Error('Meta JSON must contain a non-empty cols array.');
    }

    const cols = parsed.cols.map((col, index) => {
      if (!col || typeof col !== 'object') {
        throw new Error(`Column ${index + 1} is invalid.`);
      }
      return {
        id: typeof col.id === 'string' && col.id ? col.id : `c${index + 1}`,
        label: typeof col.label === 'string' ? col.label : '',
      };
    });

    return {
      version: Number.isInteger(parsed.version) ? parsed.version : 1,
      cols,
    };
  }

  function parseRow(blockString) {
    const parsed = JSON.parse((blockString || '').trim());
    if (!Array.isArray(parsed)) {
      throw new Error('Row JSON must be an array.');
    }

    return parsed.map((value) => value == null ? '' : String(value));
  }

  function normalizeVisibleCells(rawCells, colCount) {
    const cells = Array.isArray(rawCells) ? rawCells : [];
    return Array.from({ length: colCount }, (_, index) => {
      return typeof cells[index] === 'string' ? cells[index] : '';
    });
  }

  function isEditableTableMarkerString(value) {
    return typeof value === 'string' && MARKER_PATTERN.test(value);
  }

  function isMetaBlockString(value) {
    return typeof value === 'string' && value.trim().startsWith(META_PREFIX);
  }

  function isRowsBlockString(value) {
    return typeof value === 'string' && value.trim().startsWith(ROWS_PREFIX);
  }

  function getApi() {
    if (!window.roamAlphaAPI) {
      throw new Error('roamAlphaAPI is unavailable.');
    }
    return window.roamAlphaAPI;
  }

  async function pullBlock(uid) {
    return getApi().pull(`[:block/uid :block/string]`, [':block/uid', uid]);
  }

  async function pullTableTree(uid) {
    return getApi().pull(
      `[
        :block/uid
        :block/string
        :block/order
        {:block/children [
          :block/uid
          :block/string
          :block/order
          {:block/children [
            :block/uid
            :block/string
            :block/order
          ]}
        ]}
      ]`,
      [':block/uid', uid]
    );
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

  // Column definitions live in table-meta:: so header edits and column structure changes update one block.
  async function saveMeta(metaUid, meta) {
    await getApi().updateBlock({
      block: {
        uid: metaUid,
        string: `${META_PREFIX} ${JSON.stringify(meta)}`,
      },
    });
  }

  // Each table row persists as one JSON array block under table-rows:: for simple row-level writes.
  async function saveRow(rowUid, rowArray) {
    await getApi().updateBlock({
      block: {
        uid: rowUid,
        string: JSON.stringify((rowArray || []).map((value) => value == null ? '' : String(value))),
      },
    });
  }

  function generateUid() {
    const api = getApi();
    if (api.util && typeof api.util.generateUID === 'function') {
      return api.util.generateUID();
    }
    return `etable-${Math.random().toString(36).slice(2, 11)}`;
  }

  function getBlockUid(block) {
    return block ? block[KEYS.uid] : '';
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
