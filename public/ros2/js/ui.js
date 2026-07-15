/**
 * ui.js — Panel switching and drag-resize handles
 */

function switchPanel(name) {
  document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.add('active');
  event.target.classList.add('active');
  document.dispatchEvent(new CustomEvent('panelswitch', { detail: { name } }));
}

// Single drag state shared across all resizers
let _drag = null;

// axis: 'h' = top/bottom (height), 'v' = left/right (width)
// reverse: true when el1 is to the RIGHT of the resizer (right panel)
function makeResizer(id, el1, axis, reverse) {
  const r = document.getElementById(id);
  if (!r) return;

  r.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    _drag = {
      el1, axis,
      reverse:   !!reverse,
      startPos:  axis === 'h' ? e.clientY : e.clientX,
      startSize: axis === 'h' ? el1.offsetHeight : el1.offsetWidth,
    };
    r.classList.add('dragging');
    e.preventDefault();
  });
}

document.addEventListener('mousemove', (e) => {
  if (!_drag) return;
  const { el1, axis, reverse, startPos, startSize } = _drag;
  const delta = (axis === 'h' ? e.clientY : e.clientX) - startPos;
  const size  = Math.max(80, startSize + (reverse ? -delta : delta));
  if (axis === 'h') el1.style.height = size + 'px';
  else              el1.style.width  = size + 'px';
  editor?.layout?.();
  if (axis === 'h') termManager?.active?._fit();
  if (typeof resize === 'function') resize();
});

document.addEventListener('mouseup', () => {
  if (!_drag) return;
  document.querySelectorAll('.resizer.dragging').forEach(r => r.classList.remove('dragging'));
  if (_drag.axis === 'h') termManager?.active?._fit();
  if (typeof resize === 'function') resize();
  _drag = null;
});
