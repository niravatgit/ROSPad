/**
 * topics.js — Live topic Hz monitor, node graph panel, topic inspector
 *
 * Uses rosBus.onPublish() instead of BroadcastChannel, because
 * BroadcastChannel never echoes messages back to the sending window.
 */

const topicHz   = new Map(); // topic → { msgType, times[], hz, lastSeen, lastMsg }
let   inspectedTopic = null; // currently selected topic in inspector

// Track every publish — store last message payload per topic
rosBus.subscribe('*', '*', () => {}); // ensure dispatch fires (noop, real work below)

// Hook into every publish to capture last message
rosBus.onPublish((topic, msgType, stamp) => {
  if (!topicHz.has(topic)) topicHz.set(topic, { msgType, times: [], hz: 0, lastSeen: 0, lastMsg: null });
  const t = topicHz.get(topic);
  t.times.push(stamp);
  t.lastSeen = stamp;
  t.msgType  = msgType;
});

// Capture payloads via subscribe (onPublish only gives metadata)
const _capturedSubs = new Set();
function _ensureCapture(topic) {
  if (_capturedSubs.has(topic)) return;
  _capturedSubs.add(topic);
  rosBus.subscribe(topic, '*', (data) => {
    const t = topicHz.get(topic);
    if (t) t.lastMsg = data;
  });
}

// Patch rosBus.publish to also capture for the inspector
const _origPublish = rosBus.publish.bind(rosBus);
rosBus.publish = function(topic, msgType, data) {
  _origPublish(topic, msgType, data);
  const t = topicHz.get(topic);
  if (t) t.lastMsg = data;
  _ensureCapture(topic);
};

// Reset Topics panel when all nodes are stopped
window.addEventListener('rospad:stop', () => {
  topicHz.clear();
  inspectedTopic = null;
});

function _selectTopic(topic) {
  inspectedTopic = topic;
  _renderInspector();
  // Highlight selected row
  document.querySelectorAll('.topic-row').forEach(r => {
    r.classList.toggle('selected', r.dataset.topic === topic);
  });
}

function _formatValue(val, key) {
  if (Array.isArray(val) && val.length > 8 && val.every(v => typeof v === 'number' || v === null)) {
    // Compact matrix: 12 values per row
    const cols  = 12;
    const rows  = [];
    for (let i = 0; i < val.length; i += cols) {
      const slice = val.slice(i, i + cols)
        .map(v => v == null ? ' null' : v.toFixed(2).padStart(6))
        .join(' ');
      rows.push(`  [${String(i).padStart(3)}] ${slice}`);
    }
    return `[ /* ${val.length} values */\n${rows.join('\n')}\n]`;
  }
  return null; // use default JSON
}

function _formatMsg(obj, indent = 0) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    const custom = _formatValue(obj, '');
    if (custom) return custom;
    if (obj.length === 0) return '[]';
    const pad = '  '.repeat(indent + 1);
    return '[\n' + obj.map(v => pad + _formatMsg(v, indent + 1)).join(',\n') + '\n' + '  '.repeat(indent) + ']';
  }
  const pad = '  '.repeat(indent + 1);
  const entries = Object.entries(obj).map(([k, v]) => {
    const custom = Array.isArray(v) ? _formatValue(v, k) : null;
    return `${pad}"${k}": ${custom || _formatMsg(v, indent + 1)}`;
  });
  return '{\n' + entries.join(',\n') + '\n' + '  '.repeat(indent) + '}';
}

function _renderInspector() {
  const el = document.getElementById('topic-inspector');
  if (!el) return;
  if (!inspectedTopic) {
    el.innerHTML = '<div class="inspector-empty">Click a topic to inspect its last message</div>';
    return;
  }
  const info = topicHz.get(inspectedTopic);
  if (!info) {
    el.innerHTML = `<div class="inspector-empty">No data for ${inspectedTopic}</div>`;
    return;
  }
  const body = info.lastMsg != null ? _formatMsg(info.lastMsg) : '(no message received yet)';
  el.innerHTML = `
    <div class="inspector-header">
      <span class="inspector-topic">${inspectedTopic}</span>
      <span class="inspector-type">${info.msgType || ''}</span>
    </div>
    <pre class="inspector-body">${_escHtml(body)}</pre>`;
}

function _escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Render panels at 1 Hz
setInterval(() => {
  // Recompute Hz, purge topics with no messages for >4 s
  const now = performance.now();
  for (const [topic, v] of topicHz) {
    v.times = v.times.filter(ts => now - ts < 3000);
    if (v.times.length === 0 && now - (v.lastSeen || 0) > 4000) {
      topicHz.delete(topic);
      if (inspectedTopic === topic) { inspectedTopic = null; }
      continue;
    }
    v.hz = v.times.length > 1
      ? (v.times.length - 1) / ((v.times[v.times.length - 1] - v.times[0]) / 1000)
      : 0;
    _ensureCapture(topic);
  }

  // ── Topic monitor panel ───────────────────────────────────────────────────
  // Merge active (publishing) topics with declared (registered) topics so the
  // list matches what the Graph panel shows.
  const mon = document.getElementById('topic-monitor');
  const allTopics = new Map(topicHz);
  rosBus.getTopics().forEach(({ topic, msgType }) => {
    if (!allTopics.has(topic)) allTopics.set(topic, { msgType, times: [], hz: -1, lastMsg: null });
  });
  const rows = [...allTopics.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, info]) => `
      <div class="topic-row${topic === inspectedTopic ? ' selected' : ''}" data-topic="${topic}" onclick="_selectTopic('${topic}')">
        <span class="topic-name">${topic}</span>
        <span class="topic-type">${info.msgType || ''}</span>
        <span class="topic-hz">${info.hz < 0 ? '--' : info.hz.toFixed(1) + ' Hz'}</span>
      </div>`).join('');
  mon.innerHTML = rows || '<div style="padding:12px;color:var(--text2);font-size:12px">No topics active — start the sim or run a node</div>';

  // Refresh inspector if a topic is selected
  if (inspectedTopic) _renderInspector();

  // ── Node graph panel ──────────────────────────────────────────────────────
  const ng    = document.getElementById('node-graph');
  const nodes = rosBus.getNodes();
  ng.innerHTML = nodes.length
    ? nodes.map(n =>
        `<div class="node-card"><div class="node-card-name">/${n}</div></div>`
      ).join('')
    : '<div style="padding:12px;color:var(--text2);font-size:12px">No nodes running — use <span style="color:var(--accent)">ros2 run</span> or the ▶ button</div>';

  // ── Status dot + node counter ─────────────────────────────────────────────
  document.getElementById('node-counter').textContent =
    `${nodes.length} node${nodes.length !== 1 ? 's' : ''}`;
  document.getElementById('status-dot').className =
    'status-dot' + (nodes.length > 0 ? ' connected' : '');

}, 1000);
