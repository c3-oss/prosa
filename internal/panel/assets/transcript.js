// Transcript interactions for the session side panel: per-bubble
// collapse, tool/thinking group disclosure, and collapse-all. All
// event-delegated — a transcript with thousands of turns installs a
// constant number of listeners instead of one component per message.

(function () {
  'use strict';

  function setBubbleCollapsed(bubble, collapsed) {
    bubble.classList.toggle('is-collapsed', collapsed);
    var meta = bubble.querySelector('.bubble-meta');
    if (meta) {
      meta.setAttribute('aria-expanded', String(!collapsed));
      meta.setAttribute('aria-label', collapsed ? 'Expand message' : 'Collapse message');
    }
    var caret = bubble.querySelector('.bubble-caret');
    if (caret) caret.classList.toggle('is-open', !collapsed);
  }

  function setGroupOpen(group, open) {
    var entries = group.querySelector('.tool-group-entries, .thinking-entries');
    var summary = group.querySelector('.tool-group-summary, .thinking-summary');
    var caret = group.querySelector('.tool-group-caret, .thinking-caret');
    if (entries) {
      if (open) entries.removeAttribute('hidden');
      else entries.setAttribute('hidden', '');
    }
    if (summary) summary.setAttribute('aria-expanded', String(open));
    if (caret) caret.classList.toggle('is-open', open);
  }

  function toggleAllMessages(collapsed) {
    document.querySelectorAll('#side-panel .bubble').forEach(function (b) {
      setBubbleCollapsed(b, collapsed);
    });
    var btn = document.querySelector('#side-panel .sp-collapse-all');
    if (btn) {
      btn.setAttribute('aria-pressed', String(collapsed));
      btn.textContent = collapsed ? 'Expand all' : 'Collapse all';
      btn.title = collapsed ? 'Expand all messages' : 'Collapse all messages';
    }
  }

  document.addEventListener('click', function (ev) {
    var meta = ev.target.closest('.bubble-meta');
    if (meta) {
      var bubble = meta.closest('.bubble');
      if (bubble) setBubbleCollapsed(bubble, !bubble.classList.contains('is-collapsed'));
      return;
    }
    var summary = ev.target.closest('.tool-group-summary, .thinking-summary');
    if (summary) {
      var group = summary.closest('.tool-group, .thinking-group');
      if (group) setGroupOpen(group, summary.getAttribute('aria-expanded') !== 'true');
      return;
    }
    var all = ev.target.closest('.sp-collapse-all');
    if (all) toggleAllMessages(all.getAttribute('aria-pressed') !== 'true');
  });

  // The in-transcript search dispatches these window events to force
  // every message and group visible before it walks the text nodes.
  window.addEventListener('messages-toggle-all', function (ev) {
    toggleAllMessages(!!(ev.detail && ev.detail.collapsed));
  });
  window.addEventListener('transcript-expand-groups', function () {
    document.querySelectorAll('#side-panel .tool-group, #side-panel .thinking-group').forEach(function (g) {
      setGroupOpen(g, true);
    });
  });
})();
