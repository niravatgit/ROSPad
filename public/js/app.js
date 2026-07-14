/**
 * app.js — Bootstrap: wires all components together on page load
 */

// Fallback stub so terminal.js nodeManager callbacks don't throw before editor.js loads.
// editor.js sets the real implementation; don't overwrite it if it's already set.
if (!window._updateRunState) window._updateRunState = () => {};

window.addEventListener('load', () => {
  try { initSim(); } catch(e) { console.error('initSim failed:', e); }
  refreshTree();

  makeResizer('resizer-sidebar',    document.getElementById('sidebar'),        'v', false);
  makeResizer('resizer-right',      document.getElementById('right-panel'),    'v', true);
  makeResizer('resizer-terminal',   document.getElementById('terminal-panel'), 'h', false);
  makeResizer('resizer-sim-canvas', document.getElementById('sim-viewport'),   'h', false);
});

window.addEventListener('rospad:refresh-tree', refreshTree);
window.addEventListener('resize', () => { resize(); termManager?.active?._fit(); });
