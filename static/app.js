// --- State ---
let currentCode = null;
let qrModeWeb = true; // true = web URL, false = wormhole-transfer:
let transferActive = false;
let lastReceivedText = null;
let lastReceivedFilename = 'message.txt';

// --- Analytics helpers ---
function track(event, data) {
  if (typeof umami !== 'undefined') umami.track(event, data);
}

function sizeBucket(bytes) {
  if (bytes < 1024 * 1024) return '<1MB';
  if (bytes < 10 * 1024 * 1024) return '1-10MB';
  if (bytes < 100 * 1024 * 1024) return '10-100MB';
  if (bytes < 1024 * 1024 * 1024) return '100MB-1GB';
  return '>1GB';
}

// --- Beforeunload warning ---
window.addEventListener('beforeunload', function(e) {
  if (transferActive) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// --- Helpers ---
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

// --- Tab Switching ---
function switchTab(tab) {
  var sendTab = document.getElementById('main-tab-send');
  var recvTab = document.getElementById('main-tab-receive');
  var sendPanel = document.getElementById('panel-send');
  var recvPanel = document.getElementById('panel-receive');
  if (tab === 'send') {
    sendTab.classList.add('active');
    sendTab.setAttribute('aria-selected', 'true');
    recvTab.classList.remove('active');
    recvTab.setAttribute('aria-selected', 'false');
    sendPanel.classList.remove('hidden');
    recvPanel.classList.add('hidden');
  } else {
    recvTab.classList.add('active');
    recvTab.setAttribute('aria-selected', 'true');
    sendTab.classList.remove('active');
    sendTab.setAttribute('aria-selected', 'false');
    recvPanel.classList.remove('hidden');
    sendPanel.classList.add('hidden');
  }
}

// --- Dark Mode Toggle ---
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : (current === 'light' ? 'dark' :
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
  html.setAttribute('data-theme', next);
  updateThemeToggle(next === 'dark');
  try { localStorage.setItem('theme', next); } catch (_) {}
}

function updateThemeToggle(isDark) {
  document.getElementById('theme-icon-sun').style.display = isDark ? 'none' : '';
  document.getElementById('theme-icon-moon').style.display = isDark ? '' : 'none';
  const btn = document.getElementById('theme-toggle');
  btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  btn.setAttribute('aria-checked', String(isDark));
}

// Initialize theme
(function() {
  let theme;
  try { theme = localStorage.getItem('theme'); } catch (_) {}
  if (theme) {
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeToggle(theme === 'dark');
  } else {
    updateThemeToggle(window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
})();

// --- QR ---
function renderQr(text) {
  const container = document.getElementById('qr-display');
  container.innerHTML = '';
  if (typeof qrcode === 'undefined') return;
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  // cellSize=6 for better scannability on phone cameras
  container.innerHTML = qr.createSvgTag(6, 0);
}

function getReceiveUrl() {
  return window.location.origin + '/receive/' + currentCode;
}

function updateCodeDisplay() {
  const box = document.getElementById('send-code');
  if (qrModeWeb) {
    box.textContent = getReceiveUrl();
  } else {
    box.textContent = currentCode;
  }
}

function setQrMode(web) {
  qrModeWeb = web;
  document.getElementById('tab-web').classList.toggle('active', web);
  document.getElementById('tab-wormhole').classList.toggle('active', !web);
  document.getElementById('tab-web').setAttribute('aria-selected', String(web));
  document.getElementById('tab-wormhole').setAttribute('aria-selected', String(!web));
  if (web) {
    renderQr(getReceiveUrl());
  } else {
    renderQr('wormhole-transfer:' + currentCode);
  }
  updateCodeDisplay();
}

function copyCode() {
  const text = qrModeWeb ? getReceiveUrl() : currentCode;
  track('code-copy', { mode: qrModeWeb ? 'web' : 'wormhole' });
  navigator.clipboard.writeText(text).then(() => {
    const label = document.getElementById('copy-label');
    label.textContent = 'Copied!';
    setTimeout(() => { label.textContent = 'Copy'; }, 1000);
  });
}

function shareCode() {
  track('code-share', { mode: qrModeWeb ? 'web' : 'wormhole' });
  const text = qrModeWeb ? getReceiveUrl() : 'wormhole receive ' + currentCode;
  const data = { text: text };
  if (qrModeWeb) {
    data.title = 'Receive file via wormhole.page';
    data.url = getReceiveUrl();
  } else {
    data.title = 'Receive file via wormhole';
  }
  navigator.share(data).catch(() => {});
}

// --- Send ---
// Accepts a single File or an array of Files
function startSend(fileOrFiles) {
  if (!window.wasmClient || !window.wasmClient.ready) {
    // WASM not loaded -- can't proceed
    return;
  }
  // Clean up any previous send to avoid leaking relay connections
  window.wasmClient.cancelSend();
  var files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  if (files.length === 0) return;
  startSendWasm(files.length === 1 ? files[0] : files);
}

function startSendWasm(fileOrFiles) {
  hide('send-initial');
  show('send-status');

  var files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  var isMulti = files.length > 1;

  if (isMulti) {
    var totalSize = files.reduce(function(sum, f) { return sum + f.size; }, 0);
    document.getElementById('send-filename').textContent = files.length + ' files';
    document.getElementById('send-filesize').textContent = formatSize(totalSize) + ' total (will be sent as zip)';
  } else {
    document.getElementById('send-filename').textContent = files[0].name;
    document.getElementById('send-filesize').textContent = formatSize(files[0].size);
  }
  document.getElementById('send-status-text').textContent = 'allocating code...';
  document.getElementById('send-status-text').className = 'status-text';
  document.getElementById('send-progress').style.width = '0%';
  document.getElementById('send-progress').className = 'progress-bar';
  document.getElementById('send-progress').setAttribute('aria-valuenow', '0');
  hide('send-code-section');
  hide('send-transfer-info');
  show('send-keep-open');

  document.getElementById('send-status-text').focus();

  var totalSize = files.reduce(function(sum, f) { return sum + f.size; }, 0);
  track('send-start', { files: files.length, size: sizeBucket(totalSize) });

  window.wasmClient.send(fileOrFiles, {
    onCode(code) {
      currentCode = code;
      show('send-code-section');
      setQrMode(true);
      if (navigator.share) {
        document.getElementById('btn-share').style.display = '';
      }
    },
    onStatus(text) {
      document.getElementById('send-status-text').textContent = text;
    },
    onProgress(pct, speed, connType) {
      transferActive = true;
      document.getElementById('send-progress').style.width = pct + '%';
      document.getElementById('send-progress').setAttribute('aria-valuenow', String(pct));
      if (speed) {
        var info = speed + (connType ? ' \u00b7 ' + connType : '');
        document.getElementById('send-transfer-info').textContent = info;
        show('send-transfer-info');
      }
    },
    onError(msg) {
      transferActive = false;
      hide('send-keep-open');
      track('send-error', { error: msg });
      document.getElementById('send-status-text').textContent = msg;
      document.getElementById('send-status-text').className = 'status-text error';
      var btn = document.getElementById('send-cancel-btn');
      btn.textContent = 'New Transfer';
      btn.className = 'btn';
      btn.style.width = '100%';
      btn.style.marginTop = '8px';
      btn.focus();
    },
    onComplete() {
      transferActive = false;
      track('send-complete');
      markSendComplete();
    },
  });
}

function markSendComplete() {
  hide('send-code-section');
  hide('send-keep-open');
  document.getElementById('send-progress').style.width = '100%';
  document.getElementById('send-progress').className = 'progress-bar done';
  document.getElementById('send-progress').setAttribute('aria-valuenow', '100');
  document.getElementById('send-status-text').textContent = '\u2714 Transfer complete!';
  document.getElementById('send-status-text').className = 'status-text done';
  // Change cancel to New Transfer with primary style
  var btn = document.getElementById('send-cancel-btn');
  btn.textContent = 'New Transfer';
  btn.className = 'btn';
  btn.style.width = '100%';
  btn.style.marginTop = '8px';
  btn.focus();
}

function cancelSend() {
  if (window.wasmClient) window.wasmClient.cancelSend();
  transferActive = false;
  currentCode = null;
  hide('send-status');
  show('send-initial');
  document.getElementById('file-input').value = '';
  document.getElementById('folder-input').value = '';
  // Reset button
  var btn = document.getElementById('send-cancel-btn');
  btn.textContent = 'Cancel';
  btn.className = 'btn btn-cancel';
  btn.style.width = '';
  btn.style.marginTop = '';
  // Update progress bar ARIA
  var prog = document.getElementById('send-progress');
  if (prog) prog.setAttribute('aria-valuenow', '0');
}

// --- Receive ---
function startReceive() {
  var input = document.getElementById('receive-code');
  var code = input.value.trim().toLowerCase().replace(/\s+/g, '');
  if (!code) return;
  input.value = ''; // code is single-use — clear it immediately
  if (!window.wasmClient || !window.wasmClient.ready) return;
  // Clean up any previous receive to avoid leaking relay connections
  window.wasmClient.cancelReceive();
  startReceiveWasm(code);
}

function startReceiveWasm(code) {
  hide('receive-initial');
  show('receive-status');
  hide('receive-file-info');
  hide('receive-text-panel');
  hide('receive-progress-section');
  hide('receive-transfer-info');
  lastReceivedText = null;
  lastReceivedFilename = 'message.txt';
  document.getElementById('receive-spinner').style.display = '';
  document.getElementById('receive-status-text').textContent = 'establishing encrypted connection...';
  document.getElementById('receive-status-text').className = 'status-text';


  document.getElementById('receive-status-text').focus();

  var isDirectLink = window.location.pathname.match(/^\/receive\/.+$/);
  track('receive-start', { method: isDirectLink ? 'link' : 'code' });

  window.wasmClient.receive(code, {
    onFileInfo(filename, filesize) {
      lastReceivedFilename = filename;
      document.getElementById('receive-filename').textContent = filename;
      var sizeText = formatSize(filesize);
      if (filename.endsWith('.zip')) {
        sizeText += ' (zip archive — extract after download)';
      }
      document.getElementById('receive-filesize').textContent = sizeText;
      show('receive-file-info');
      document.getElementById('receive-spinner').style.display = 'none';
    },
    onText(text) {
      lastReceivedText = text;
      const pre = document.getElementById('receive-text-content');
      pre.textContent = text;
      document.getElementById('receive-filename').textContent = lastReceivedFilename + ' (text)';
      show('receive-text-panel');
    },
    onStatus(text) {
      document.getElementById('receive-status-text').textContent = text;
    },
    onProgress(pct, speed, connType) {
      transferActive = true;
      show('receive-progress-section');
      document.getElementById('receive-progress').style.width = pct + '%';
      document.getElementById('receive-progress').setAttribute('aria-valuenow', String(pct));
      if (speed) {
        var info = speed + (connType ? ' \u00b7 ' + connType : '');
        document.getElementById('receive-transfer-info').textContent = info;
        show('receive-transfer-info');
      }
    },
    onError(msg) {
      transferActive = false;
      track('receive-error', { error: msg });
      document.getElementById('receive-status-text').textContent = msg;
      document.getElementById('receive-status-text').className = 'status-text error';
      document.getElementById('receive-spinner').style.display = 'none';
      var btn = document.getElementById('receive-cancel-btn');
      btn.textContent = 'New Transfer';
      btn.className = 'btn';
      btn.style.width = '100%';
      btn.style.marginTop = '8px';
      btn.focus();
    },
    onComplete() {
      transferActive = false;
      track('receive-complete');
      document.getElementById('receive-progress').style.width = '100%';
      document.getElementById('receive-progress').className = 'progress-bar done';
      document.getElementById('receive-progress').setAttribute('aria-valuenow', '100');
      document.getElementById('receive-status-text').textContent = '\u2714 Transfer complete!';
      document.getElementById('receive-status-text').className = 'status-text done';
      // Change cancel to New Transfer
      var btn = document.getElementById('receive-cancel-btn');
      btn.textContent = 'New Transfer';
      btn.className = 'btn';
      btn.style.width = '100%';
      btn.style.marginTop = '8px';
      btn.focus();
    },
  });
}

function cancelReceive() {
  if (window.wasmClient) window.wasmClient.cancelReceive();
  transferActive = false;
  hide('receive-text-panel');
  // If on a /receive/<code> URL, redirect to clean root
  if (window.location.pathname.match(/^\/receive\/.+$/)) {
    window.history.replaceState(null, '', '/');
  }
  hide('receive-status');
  show('receive-initial');
  // Reset button
  var btn = document.getElementById('receive-cancel-btn');
  btn.textContent = 'Cancel';
  btn.className = 'btn btn-cancel';
  btn.style.width = '';
  btn.style.marginTop = '';
  // Update progress bar ARIA
  var prog = document.getElementById('receive-progress');
  if (prog) prog.setAttribute('aria-valuenow', '0');
}

// --- Drag and drop ---
var dz = document.getElementById('dropzone');

dz.addEventListener('click', function(e) {
  if (e.target.id !== 'file-input' && e.target.id !== 'folder-input') {
    document.getElementById('file-input').click();
  }
});

dz.addEventListener('dragover', function(e) {
  e.preventDefault();
  dz.classList.add('dragover');
});

dz.addEventListener('dragleave', function() {
  dz.classList.remove('dragover');
});

dz.addEventListener('drop', function(e) {
  e.preventDefault();
  dz.classList.remove('dragover');
  var items = e.dataTransfer.items;
  // Check if any item is a directory (use webkitGetAsEntry for folder detection)
  var hasEntries = items && items.length > 0 && items[0].webkitGetAsEntry;
  if (hasEntries) {
    // Use entry API to traverse directories
    window.wasmClient.traverseEntries(items).then(function(files) {
      if (files.length > 0) {
        startSend(files.length === 1 ? files[0] : files);
      }
    }).catch(function() {
      // Fallback to flat file list
      var files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        startSend(files.length === 1 ? files[0] : files);
      }
    });
  } else if (e.dataTransfer.files.length > 0) {
    var files = Array.from(e.dataTransfer.files);
    startSend(files.length === 1 ? files[0] : files);
  }
});

dz.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('file-input').click();
  }
});

document.getElementById('file-input').addEventListener('change', function() {
  if (this.files.length > 0) {
    var files = Array.from(this.files);
    startSend(files.length === 1 ? files[0] : files);
  }
});

document.getElementById('folder-input').addEventListener('change', function() {
  if (this.files.length > 0) {
    startSend(Array.from(this.files));
  }
});

// Click code box to copy
document.getElementById('send-code').addEventListener('click', copyCode);

// --- WASM initialization ---
if (window.wasmClient) {
  window.wasmClient.initWasm();
}

// --- Pre-filled receive from URL ---
(function() {
  var match = window.location.pathname.match(/^\/receive\/(.+)$/);
  if (match) {
    var code = decodeURIComponent(match[1]);
    // Wait for WASM to be ready (up to 3 seconds), then start
    var attempts = 0;
    var tryStart = function() {
      if (window.wasmClient && window.wasmClient.ready) {
        switchTab('receive');
        document.getElementById('receive-code').value = code;
        startReceive();
      } else if (attempts < 30) {
        attempts++;
        setTimeout(tryStart, 100);
      } else {
        // Fallback: fill the code input and let user click
        switchTab('receive');
        document.getElementById('receive-code').value = code;
      }
    };
    tryStart();
  }
})();

// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- Event Listeners (replacing inline handlers for CSP compliance) ---
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('main-tab-send').addEventListener('click', function() { switchTab('send'); });
document.getElementById('main-tab-receive').addEventListener('click', function() { switchTab('receive'); });
document.getElementById('btn-folder').addEventListener('click', function() { document.getElementById('folder-input').click(); });
document.getElementById('btn-copy').addEventListener('click', copyCode);
document.getElementById('btn-share').addEventListener('click', shareCode);
document.getElementById('tab-web').addEventListener('click', function() { setQrMode(true); });
document.getElementById('tab-wormhole').addEventListener('click', function() { setQrMode(false); });
document.getElementById('send-cancel-btn').addEventListener('click', cancelSend);
document.getElementById('receive-code').addEventListener('keydown', function(e) { if (e.key === 'Enter') startReceive(); });
document.getElementById('receive-btn').addEventListener('click', startReceive);
document.getElementById('receive-cancel-btn').addEventListener('click', cancelReceive);

// --- Settings modal: per-user relay server overrides ---
// Storage schema v2 in localStorage (this browser only, never sent to the server):
//   { profile: 'deployment' }                                   — deployment default
//   { profile: 'custom', mailboxUrl?, transitRelayUrl?, transitTcpHint? }
// v1 ({mailboxUrl, transitRelayUrl} without a profile) reads as custom and is
// written back in v2 on the next save.
// Priority: localStorage (custom) > window.WORMHOLE_CONFIG (server /config.js)
//           > window.WORMHOLE_* (legacy operator <script> injection) > built-in default.
const SETTINGS_KEY = 'wormhole-settings';
const SETTINGS_DEFAULT_MAILBOX = 'wss://relay.magic-wormhole.io:443/v1';
const settingsDefaultTransit = () =>
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/transit';

function operatorConfig() {
  try {
    const c = window.WORMHOLE_CONFIG;
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  } catch (_) {
    return {};
  }
}

const nonEmptyStr = v => (typeof v === 'string' && v.trim()) ? v.trim() : undefined;

function deploymentDefaults() {
  const c = operatorConfig();
  return {
    profileName: nonEmptyStr(c.profileName) || 'Deployment default',
    mailbox: nonEmptyStr(c.mailboxUrl) || window.WORMHOLE_MAILBOX_URL || SETTINGS_DEFAULT_MAILBOX,
    transit: nonEmptyStr(c.transitUrl) || window.WORMHOLE_TRANSIT_RELAY || settingsDefaultTransit(),
  };
}

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { profile: 'deployment' };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { profile: 'deployment' };
    // v1 migration (read-only; rewritten in v2 on next save)
    if (!parsed.profile && (parsed.mailboxUrl || parsed.transitRelayUrl || parsed.transitTcpHint)) {
      parsed.profile = 'custom';
    }
    if (parsed.profile !== 'custom') parsed.profile = 'deployment';
    return parsed;
  } catch (_) {
    return { profile: 'deployment' };
  }
}

function updateSettingsDot() {
  const custom = readSettings().profile === 'custom';
  const dot = document.getElementById('settings-dot');
  if (dot) dot.classList.toggle('hidden', !custom);
}

function validateRelayUrl(raw) {
  const value = raw.trim();
  if (!value) return { ok: true, value: '' }; // empty = use default
  if (value.length > 2048) return { ok: false, error: 'URL is too long (max 2048 characters)' };
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return { ok: false, error: 'Not a valid URL' };
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    return { ok: false, error: 'URL must start with ws:// or wss://' };
  }
  if (!url.hostname) return { ok: false, error: 'URL has no host' };
  return { ok: true, value };
}

function validateTcpHint(raw) {
  const value = raw.trim();
  if (!value) return { ok: true, value: '' }; // empty = advertise public upstream relay
  if (value.length > 2048) return { ok: false, error: 'TCP hint is too long (max 2048 characters)' };
  if (!value.startsWith('tcp://')) return { ok: false, error: 'TCP hint must start with tcp://' };
  try {
    const url = new URL(value);
    if (!url.hostname) return { ok: false, error: 'TCP hint has no host' };
  } catch (_) {
    return { ok: false, error: 'Not a valid TCP hint' };
  }
  return { ok: true, value };
}

function settingsElements() {
  return {
    overlay: document.getElementById('settings-overlay'),
    profile: document.getElementById('settings-profile'),
    customRows: document.getElementById('settings-custom-rows'),
    summary: document.getElementById('settings-active-summary'),
    mailbox: document.getElementById('settings-mailbox-url'),
    transit: document.getElementById('settings-transit-url'),
    hint: document.getElementById('settings-transit-hint'),
    error: document.getElementById('settings-error'),
    save: document.getElementById('settings-save'),
    reset: document.getElementById('settings-reset'),
    cancel: document.getElementById('settings-cancel'),
    test: document.getElementById('settings-test'),
    testResult: document.getElementById('settings-test-result'),
    closeBtn: document.getElementById('settings-close'),
    toggle: document.getElementById('settings-toggle'),
  };
}

function showSettingsError(msg, invalidField) {
  const { error, mailbox, transit, hint } = settingsElements();
  error.textContent = msg || '';
  error.classList.toggle('hidden', !msg);
  mailbox.setAttribute('aria-invalid', String(invalidField === mailbox));
  transit.setAttribute('aria-invalid', String(invalidField === transit));
  if (hint) hint.setAttribute('aria-invalid', String(invalidField === hint));
}

function populateProfileOptions(select) {
  const defaults = deploymentDefaults();
  select.innerHTML = '';
  const optDefault = document.createElement('option');
  optDefault.value = 'deployment';
  optDefault.textContent = defaults.profileName + ' (default)';
  const optCustom = document.createElement('option');
  optCustom.value = 'custom';
  optCustom.textContent = 'Custom (advanced)…';
  select.append(optDefault, optCustom);
}

function setTestResult(msg, kind) {
  const { testResult } = settingsElements();
  if (!testResult) return;
  testResult.textContent = msg || '';
  testResult.classList.toggle('ok', kind === 'ok');
  testResult.classList.toggle('err', kind === 'err');
}

function syncCustomRowsVisibility() {
  const el = settingsElements();
  const custom = el.profile.value === 'custom';
  el.customRows.classList.toggle('hidden', !custom);
  el.summary.classList.toggle('hidden', custom);
}

function renderSettingsUI() {
  const el = settingsElements();
  const s = readSettings();
  const d = deploymentDefaults();
  el.profile.value = s.profile === 'custom' ? 'custom' : 'deployment';
  syncCustomRowsVisibility();
  const custom = el.profile.value === 'custom';
  if (custom) {
    el.mailbox.value = s.mailboxUrl || '';
    el.transit.value = s.transitRelayUrl || '';
    el.hint.value = s.transitTcpHint || '';
  } else {
    el.summary.textContent = 'Using ' + d.profileName + ' — mailbox: ' + d.mailbox + ' · transit: ' + d.transit;
  }
  el.mailbox.placeholder = d.mailbox;
  el.transit.placeholder = d.transit;
}

function openSettings() {
  const el = settingsElements();
  populateProfileOptions(el.profile);
  renderSettingsUI();
  showSettingsError('', null);
  setTestResult('');
  el.overlay.classList.remove('hidden');
  el.profile.focus();
  el.toggle.setAttribute('aria-expanded', 'true');
}

function closeSettings() {
  const { overlay, toggle } = settingsElements();
  overlay.classList.add('hidden');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.focus();
}

function saveSettings() {
  const el = settingsElements();
  const selected = el.profile.value;
  if (selected === 'deployment') {
    try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
    updateSettingsDot();
    closeSettings();
    return;
  }
  const mb = validateRelayUrl(el.mailbox.value);
  if (!mb.ok) return showSettingsError('Mailbox server: ' + mb.error, el.mailbox);
  const tr = validateRelayUrl(el.transit.value);
  if (!tr.ok) return showSettingsError('Transit relay: ' + tr.error, el.transit);
  const th = validateTcpHint(el.hint.value);
  if (!th.ok) return showSettingsError('TCP hint: ' + th.error, el.hint);

  const next = { profile: 'custom' };
  if (mb.value) next.mailboxUrl = mb.value;
  if (tr.value) next.transitRelayUrl = tr.value;
  if (th.value) next.transitTcpHint = th.value;
  try {
    if (Object.keys(next).length === 1) localStorage.removeItem(SETTINGS_KEY);
    else localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch (_) {
    return showSettingsError('Could not save settings (browser storage unavailable)', null);
  }
  updateSettingsDot();
  closeSettings();
}

function resetSettings() {
  const el = settingsElements();
  el.profile.value = 'deployment';
  el.mailbox.value = '';
  el.transit.value = '';
  el.hint.value = '';
  try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
  renderSettingsUI();
  showSettingsError('', null);
  setTestResult('');
  updateSettingsDot();
  el.profile.focus();
}

// Open a WebSocket to the currently effective mailbox URL and report whether
// it completes the handshake. No data is sent; the socket is closed immediately.
function probeMailbox(url) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let done = false;
    const timer = setTimeout(() => finish(false, 'timed out after 5s'), 5000);
    function finish(ok, error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      resolve({ ok, error });
    }
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false, 'connection failed' + (location.protocol === 'https:' ? ' (on HTTPS pages only wss:// relays are reachable)' : ''));
    ws.onclose = (e) => { if (!done) finish(e.wasClean, 'closed before handshake (code ' + e.code + ')'); };
  });
}

async function testConnection() {
  const el = settingsElements();
  let url;
  if (el.profile.value === 'custom') {
    // Test what the user typed (falling back to the field placeholder), not
    // what was previously saved — the whole point is checking edits before save.
    const mb = validateRelayUrl(el.mailbox.value);
    if (!mb.ok) return showSettingsError('Mailbox server: ' + mb.error, el.mailbox);
    url = mb.value || deploymentDefaults().mailbox;
  } else {
    url = deploymentDefaults().mailbox;
  }
  setTestResult('Testing ' + url + ' …');
  const result = await probeMailbox(url);
  if (result.ok) setTestResult('Connected to ' + url + ' ✓', 'ok');
  else setTestResult('Could not connect: ' + (result.error || 'unknown error'), 'err');
}

(function initSettings() {
  const el = settingsElements();
  const { overlay, save, reset, cancel, closeBtn, toggle, profile } = el;
  if (!overlay) return;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', openSettings);
  closeBtn.addEventListener('click', closeSettings);
  cancel.addEventListener('click', closeSettings);
  save.addEventListener('click', saveSettings);
  reset.addEventListener('click', resetSettings);
  profile.addEventListener('change', syncCustomRowsVisibility);
  if (el.test) el.test.addEventListener('click', testConnection);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeSettings();
  });
  updateSettingsDot();
})();

// --- Send text messages ---
const MAX_TEXT_BYTES = 512 * 1024; // keep in sync with wasm-client.js MAX_INLINE_TEXT_SIZE
const sendTextPanel = document.getElementById('send-text-panel');
const sendTextInput = document.getElementById('send-text-input');
const sendTextSubmit = document.getElementById('send-text-submit');
const sendTextHint = document.getElementById('send-text-hint');

function setSendTextHint(msg) {
  if (!sendTextHint) return;
  sendTextHint.textContent = msg || '';
  sendTextHint.classList.toggle('hidden', !msg);
}

function updateSendTextSubmit() {
  if (sendTextSubmit) sendTextSubmit.disabled = sendTextInput.value.trim().length === 0;
  setSendTextHint('');
}

function toggleSendText(show) {
  sendTextPanel.classList.toggle('hidden', !show);
  document.getElementById('btn-text').classList.toggle('hidden', show);
  if (show) sendTextInput.focus();
  else {
    setSendTextHint('');
  }
}

if (sendTextPanel && document.getElementById('btn-text')) {
  document.getElementById('btn-text').addEventListener('click', function() { toggleSendText(true); });
  document.getElementById('send-text-cancel').addEventListener('click', function() {
    sendTextInput.value = '';
    updateSendTextSubmit();
    toggleSendText(false);
  });
  sendTextInput.addEventListener('input', updateSendTextSubmit);
  sendTextInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !sendTextSubmit.disabled) {
      sendTextSubmit.click();
    }
  });
  sendTextSubmit.addEventListener('click', function() {
    const text = sendTextInput.value;
    if (!text.trim()) return;
    if (new Blob([text]).size > MAX_TEXT_BYTES) {
      setSendTextHint('Text is too large (max 512 KB). Send a file instead.');
      return;
    }
    sendTextInput.value = '';
    updateSendTextSubmit();
    toggleSendText(false);
    track('send-text', { size: sizeBucket(new Blob([text]).size) });
    startSend(new File([text], 'message.txt', { type: 'text/plain' }));
  });
}

// --- Receive text messages ---
if (document.getElementById('btn-copy-text')) {
  document.getElementById('btn-copy-text').addEventListener('click', function() {
    if (lastReceivedText === null) return;
    navigator.clipboard.writeText(lastReceivedText).then(function() {
      var label = document.getElementById('copy-text-label');
      label.textContent = 'Copied!';
      setTimeout(function() { label.textContent = 'Copy'; }, 1000);
    });
  });
  document.getElementById('btn-download-text').addEventListener('click', function() {
    if (lastReceivedText === null) return;
    var url = URL.createObjectURL(new Blob([lastReceivedText], { type: 'text/plain' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = lastReceivedFilename || 'message.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
  });
}
