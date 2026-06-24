// Tiny vanilla widgets for the panel: a click-to-open dropdown used by
// the device filter, the heatmap hover tooltip, and the inline
// "friendly name" edit toggle on /devices. No framework, no build step.

(function () {
  'use strict';

  // --- click-to-open dropdown ----------------------------------------------
  // Markup: <div class="dropdown"><button class="dropdown-toggle">…</button>
  //          <div class="dropdown-menu" hidden>…</div></div>
  // The menu closes on outside-click and Esc.
  function initDropdowns(root) {
    root.querySelectorAll('.dropdown-toggle').forEach(function (btn) {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var menu = btn.nextElementSibling;
        if (!menu || !menu.classList.contains('dropdown-menu')) return;
        var open = !menu.hasAttribute('hidden');
        closeAllDropdowns();
        if (!open) menu.removeAttribute('hidden');
      });
    });
  }
  function closeAllDropdowns() {
    document.querySelectorAll('.dropdown-menu').forEach(function (m) {
      m.setAttribute('hidden', '');
    });
  }
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest('.dropdown')) closeAllDropdowns();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeAllDropdowns();
  });

  // --- heatmap hover tooltip -----------------------------------------------
  // Markup: each populated .heatmap-cell carries data-date, data-total, and
  // data-breakdown="agent:count,agent:count,…". A single floating tip
  // element is created once and reused.
  var tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'heatmap-tip';
    tip.setAttribute('hidden', '');
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(cell) {
    var date = cell.dataset.date;
    if (!date) return;
    var total = cell.dataset.total || '0';
    var breakdown = cell.dataset.breakdown || '';
    var tipEl = ensureTip();
    var lines = ['<div class="heatmap-tip-head">' + escapeHTML(date) + ' · ' + escapeHTML(total) + ' sessions</div>'];
    if (breakdown) {
      var parts = breakdown.split(',');
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split(':');
        if (kv.length !== 2) continue;
        lines.push('<div class="heatmap-tip-row"><span>' + escapeHTML(kv[0]) + '</span><span>' + escapeHTML(kv[1]) + '</span></div>');
      }
    }
    tipEl.innerHTML = lines.join('');
    tipEl.removeAttribute('hidden');
    var rect = cell.getBoundingClientRect();
    var tipRect = tipEl.getBoundingClientRect();
    var top = window.scrollY + rect.top - tipRect.height - 6;
    var left = window.scrollX + rect.left + rect.width / 2 - tipRect.width / 2;
    if (top < window.scrollY + 4) top = window.scrollY + rect.bottom + 6;
    if (left < window.scrollX + 4) left = window.scrollX + 4;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - tipRect.width - 4;
    if (left > maxLeft) left = maxLeft;
    tipEl.style.top = top + 'px';
    tipEl.style.left = left + 'px';
  }
  function hideTip() {
    if (tip) tip.setAttribute('hidden', '');
  }
  // Delegate the floating tooltip on any container holding .heatmap-cell
  // nodes — the Home activity grid and the Insights punch card share it.
  function bindHeatmapTips(grid) {
    if (!grid || grid.dataset.bound === '1') return;
    grid.dataset.bound = '1';
    grid.addEventListener('mouseover', function (ev) {
      var cell = ev.target.closest('.heatmap-cell');
      if (cell && cell.dataset.date) showTip(cell);
    });
    grid.addEventListener('mouseout', function (ev) {
      var cell = ev.target.closest('.heatmap-cell');
      if (cell) hideTip();
    });
    grid.addEventListener('focusin', function (ev) {
      var cell = ev.target.closest('.heatmap-cell');
      if (cell && cell.dataset.date) showTip(cell);
    });
    grid.addEventListener('focusout', hideTip);
  }
  function initHeatmap(root) {
    root.querySelectorAll('.heatmap-grid, .punchcard').forEach(bindHeatmapTips);
  }

  // --- friendly-name edit toggle -------------------------------------------
  // Markup: <td class="rename-cell"><span class="rename-view">…<button class="rename-edit"></button></span>
  //         <form class="rename-form" hidden>…<button class="rename-cancel"></button></form></td>
  function initRename(root) {
    root.querySelectorAll('.rename-cell').forEach(function (cell) {
      if (cell.dataset.bound === '1') return;
      cell.dataset.bound = '1';
      var view = cell.querySelector('.rename-view');
      var form = cell.querySelector('.rename-form');
      var edit = cell.querySelector('.rename-edit');
      var cancel = cell.querySelector('.rename-cancel');
      var input = form ? form.querySelector('input[name="friendly_name"]') : null;
      if (!view || !form || !edit) return;
      edit.addEventListener('click', function (ev) {
        ev.preventDefault();
        view.setAttribute('hidden', '');
        form.removeAttribute('hidden');
        if (input) {
          input.focus();
          input.select();
        }
      });
      if (cancel) {
        cancel.addEventListener('click', function (ev) {
          ev.preventDefault();
          form.setAttribute('hidden', '');
          view.removeAttribute('hidden');
          edit.focus();
        });
      }
      if (input) {
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            form.setAttribute('hidden', '');
            view.removeAttribute('hidden');
            edit.focus();
          }
        });
      }
    });
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // --- session table row open ----------------------------------------------
  function initRowOpen(root) {
    root.querySelectorAll('tr.session-row[data-href]').forEach(function (row) {
      if (row.dataset.boundOpen === '1') return;
      row.dataset.boundOpen = '1';
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('a, button, input, label, select, textarea')) return;
        var detail = row.getAttribute('data-detail');
        if (window.htmx && detail) {
          window.htmx.ajax('GET', detail, { target: '#side-panel', swap: 'innerHTML', source: row });
          return;
        }
        var href = row.getAttribute('data-href');
        if (href) window.location.href = href;
      });
    });
  }

  function initAll(root) {
    initDropdowns(root);
    initHeatmap(root);
    initRename(root);
    initRowOpen(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initAll(document); });
  } else {
    initAll(document);
  }
  // HTMX may swap fragments in — re-bind whatever lands.
  document.addEventListener('htmx:afterSwap', function (ev) { initAll(ev.target); });
})();
