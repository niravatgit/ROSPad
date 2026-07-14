/**
 * graph.js — rqt_graph style node/topic visualiser (Cytoscape.js)
 */

let _cy        = null;
let _gInterval = null;
let _lastHash  = '';

// ── Styles ────────────────────────────────────────────────────────────────────

const _PALETTES = {
  dark: {
    nodeBg: '#0d2218', nodeBorder: '#3fb950', nodeText: '#3fb950',
    topicBg: '#0c1a2a', topicBorder: '#58a6ff', topicText: '#58a6ff',
    pubLine: '#2d7a42', pubArrow: '#3fb950',
    subLine: '#1e4a78', subArrow: '#58a6ff',
    selectedBorder: '#e6edf3',
    canvasBg: '#0d1117',
    emptyText: '#8b949e', emptyHint: '#30363d',
  },
  light: {
    nodeBg: '#dcfce7', nodeBorder: '#1a7f37', nodeText: '#116329',
    topicBg: '#dbeafe', topicBorder: '#0969da', topicText: '#0550ae',
    pubLine: '#1a7f37', pubArrow: '#116329',
    subLine: '#0969da', subArrow: '#0550ae',
    selectedBorder: '#24292f',
    canvasBg: '#f6f8fa',
    emptyText: '#57606a', emptyHint: '#d0d7de',
  },
};

function _buildStyle(p) {
  return [
    {
      selector: 'node[ntype="ros-node"]',
      style: {
        shape: 'roundrectangle', width: 130, height: 34,
        'background-color': p.nodeBg,
        'border-color': p.nodeBorder, 'border-width': 1.5,
        label: 'data(label)', color: p.nodeText,
        'font-size': 11, 'font-weight': 'bold',
        'font-family': 'monospace, sans-serif',
        'text-valign': 'center', 'text-halign': 'center',
      },
    },
    {
      selector: 'node[ntype="topic"]',
      style: {
        shape: 'ellipse', width: 160, height: 34,
        'background-color': p.topicBg,
        'border-color': p.topicBorder, 'border-width': 1.5,
        label: 'data(label)', color: p.topicText,
        'font-size': 10, 'font-family': 'monospace, sans-serif',
        'text-valign': 'center', 'text-halign': 'center',
      },
    },
    {
      selector: 'node:selected',
      style: { 'border-color': p.selectedBorder, 'border-width': 2.5 },
    },
    {
      selector: 'edge[etype="pub"]',
      style: {
        'line-color': p.pubLine, 'target-arrow-color': p.pubArrow,
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
        width: 1.5, opacity: 0.85,
      },
    },
    {
      selector: 'edge[etype="sub"]',
      style: {
        'line-color': p.subLine, 'target-arrow-color': p.subArrow,
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
        width: 1.5, opacity: 0.85,
      },
    },
  ];
}

function _currentPalette() {
  return localStorage.getItem('rospad-theme') === 'light' ? _PALETTES.light : _PALETTES.dark;
}

window.updateGraphTheme = function(mode) {
  const p = _PALETTES[mode] || _PALETTES.dark;
  const bg = document.getElementById('graph-cy');
  if (bg) bg.style.background = p.canvasBg;
  const emptyText = document.querySelector('#graph-empty span:first-child');
  const emptyHint = document.querySelector('#graph-empty span:last-child');
  if (emptyText) emptyText.style.color = p.emptyText;
  if (emptyHint) emptyHint.style.color = p.emptyHint;
  if (_cy) _cy.style(_buildStyle(p));
  // Update legend swatch colors
  const swatches = document.querySelectorAll('#graph-legend .swatch-node, #graph-legend .swatch-topic, #graph-legend .swatch-pub, #graph-legend .swatch-sub');
  swatches.forEach(el => {
    if (el.classList.contains('swatch-node'))  { el.style.background = p.nodeBg;  el.style.borderColor = p.nodeBorder; }
    if (el.classList.contains('swatch-topic')) { el.style.background = p.topicBg; el.style.borderColor = p.topicBorder; }
    if (el.classList.contains('swatch-pub'))   el.style.background = p.pubLine;
    if (el.classList.contains('swatch-sub'))   el.style.background = p.subLine;
  });
};

// ── Layout ────────────────────────────────────────────────────────────────────
// Structured bipartite layout: ros-nodes (left column) ↔ topics (right column).
// Topics are sorted by the weighted-average y of their connected ros-nodes to
// minimise edge crossings without any force simulation.

const COL_W  = 300; // px between node column and topic column
const ROW_H  = 68;  // px between rows

function _runLayout() {
  if (!_cy || !_cy.nodes().length) return;
  _cy.resize();

  const rosNodes = _cy.nodes('[ntype="ros-node"]').toArray()
    .sort((a, b) => a.data('label').localeCompare(b.data('label')));
  const topics = _cy.nodes('[ntype="topic"]').toArray();

  // Place ros-nodes
  rosNodes.forEach((n, i) => {
    n.position({ x: 0, y: (i - (rosNodes.length - 1) / 2) * ROW_H });
  });

  // Sort topics by avg y of their connected ros-nodes
  const nodeY = new Map(rosNodes.map(n => [n.id(), n.position('y')]));
  function topicScore(t) {
    let sum = 0, cnt = 0;
    t.connectedEdges().forEach(e => {
      const other = e.source().id() === t.id() ? e.target() : e.source();
      if (nodeY.has(other.id())) { sum += nodeY.get(other.id()); cnt++; }
    });
    return cnt > 0 ? sum / cnt : 0;
  }
  topics.sort((a, b) => topicScore(a) - topicScore(b));

  topics.forEach((t, i) => {
    t.position({ x: COL_W, y: (i - (topics.length - 1) / 2) * ROW_H });
  });

  _cy.fit(undefined, 40);
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initGraph() {
  if (_cy) return;
  const panel = document.getElementById('panel-graph');
  if (!panel) return;

  const p = _currentPalette();
  panel.innerHTML = `
    <div style="display:flex;align-items:center;padding:5px 10px;border-bottom:1px solid var(--border);flex-shrink:0;gap:8px">
      <span style="font-size:11px;color:var(--text2);flex:1">Node / Topic graph — live</span>
      <button onclick="graphRelayout()" style="font-size:11px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);padding:2px 8px;border-radius:4px;cursor:pointer;line-height:1.6">⟳ Relayout</button>
    </div>
    <div style="flex:1;position:relative;overflow:hidden;min-height:0">
      <div id="graph-cy" style="position:absolute;inset:0;background:${p.canvasBg}"></div>
      <div id="graph-empty"
           style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px;pointer-events:none">
        <span style="font-size:13px;color:${p.emptyText}">No nodes running</span>
        <span style="font-size:11px;color:${p.emptyHint}">Start a node or launch a package</span>
      </div>
      <div id="graph-legend" style="position:absolute;bottom:10px;left:12px;display:flex;flex-direction:column;gap:5px;pointer-events:none">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="swatch-node" style="width:14px;height:10px;border-radius:3px;background:${p.nodeBg};border:1.5px solid ${p.nodeBorder};flex-shrink:0"></div>
          <span style="font-size:10px;color:var(--text2)">Node</span>
          <div class="swatch-pub" style="width:28px;height:1.5px;background:${p.pubLine};margin-left:8px;flex-shrink:0;position:relative">
            <div style="position:absolute;right:-4px;top:-3px;width:0;height:0;border-left:6px solid ${p.pubArrow};border-top:3.5px solid transparent;border-bottom:3.5px solid transparent"></div>
          </div>
          <span style="font-size:10px;color:var(--text2)">publish</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="swatch-topic" style="width:14px;height:10px;border-radius:7px;background:${p.topicBg};border:1.5px solid ${p.topicBorder};flex-shrink:0"></div>
          <span style="font-size:10px;color:var(--text2)">Topic</span>
          <div class="swatch-sub" style="width:28px;height:1.5px;background:${p.subLine};margin-left:8px;flex-shrink:0;position:relative">
            <div style="position:absolute;right:-4px;top:-3px;width:0;height:0;border-left:6px solid ${p.subArrow};border-top:3.5px solid transparent;border-bottom:3.5px solid transparent"></div>
          </div>
          <span style="font-size:10px;color:var(--text2)">subscribe</span>
        </div>
      </div>
    </div>`;

  // Double rAF: ensures DOM is painted and layout pass complete before Cytoscape measures size
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const container = document.getElementById('graph-cy');
      if (!container || container.offsetWidth === 0) {
        // Container not yet sized — retry once more
        setTimeout(() => {
          const c2 = document.getElementById('graph-cy');
          if (!c2) return;
          _cy = cytoscape({ container: c2, style: _buildStyle(_currentPalette()), layout: { name: 'preset' }, zoomingEnabled: true, userZoomingEnabled: true, panningEnabled: true, userPanningEnabled: true, minZoom: 0.1, maxZoom: 4, pixelRatio: 'auto' });
          _cy.resize();
          _updateGraph();
        }, 100);
        return;
      }

      _cy = cytoscape({
        container,
        style:              _buildStyle(_currentPalette()),
        layout:             { name: 'preset' },
        zoomingEnabled:     true,
        userZoomingEnabled: true,
        panningEnabled:     true,
        userPanningEnabled: true,
        minZoom: 0.1,
        maxZoom: 4,
        pixelRatio: 'auto',
      });
      _cy.resize();
      _updateGraph();
    });
  });
}

// ── Panel lifecycle ───────────────────────────────────────────────────────────

document.addEventListener('panelswitch', e => {
  if (e.detail.name === 'graph') {
    initGraph();
    if (!_gInterval) _gInterval = setInterval(_updateGraph, 2500);
    if (_cy) { _cy.resize(); _updateGraph(); }
  } else {
    if (_gInterval) { clearInterval(_gInterval); _gInterval = null; }
  }
});

function graphRelayout() {
  if (!_cy) return;
  _lastHash = ''; // force re-layout on next update
  _runLayout();
}

// ── Live update ───────────────────────────────────────────────────────────────

function _updateGraph() {
  if (!_cy) return;

  const { nodes, topics, edges } = rosBus.getGraph();
  const totalEntities = nodes.length + topics.length;

  const emptyEl  = document.getElementById('graph-empty');
  const legendEl = document.getElementById('graph-legend');
  if (emptyEl)  emptyEl.style.display  = totalEntities === 0 ? 'flex' : 'none';
  if (legendEl) legendEl.style.display = totalEntities === 0 ? 'none' : 'flex';

  // Skip redraw when nothing changed
  const hash = [
    nodes.map(n => n.id).sort().join(','),
    topics.map(t => t.id).sort().join(','),
    edges.map(e => e.from + '|' + e.to + '|' + e.type).sort().join(','),
  ].join(';');
  if (hash === _lastHash) return;
  _lastHash = hash;

  // Full clear-and-rebuild — eliminates all stale-state bugs
  _cy.startBatch();
  _cy.elements().remove();

  nodes.forEach(n => {
    _cy.add({ group: 'nodes', data: { id: n.id, label: n.name.replace(/^\//, ''), ntype: 'ros-node' } });
  });
  topics.forEach(t => {
    const label = t.name.length > 26 ? '…' + t.name.slice(-24) : t.name;
    _cy.add({ group: 'nodes', data: { id: t.id, label, ntype: 'topic' } });
  });
  edges.forEach(e => {
    _cy.add({ group: 'edges', data: { id: e.from + '→' + e.to, source: e.from, target: e.to, etype: e.type } });
  });

  _cy.endBatch();
  _runLayout();
}
