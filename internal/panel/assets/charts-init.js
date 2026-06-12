// Chart initializer for the panel. Renders the dashboard cards with
// Frappe Charts (vendored: frappe-charts.min.umd.js, global `frappe`).
//
//   Frappe Charts v1.6.2 (MIT)
//   https://cdn.jsdelivr.net/npm/frappe-charts@1.6.2/dist/frappe-charts.min.umd.js
//   sha256 efb1d15f39d58b0ebe5f019f497d983083a3b0eebd8367c5bb328a5a0a3e5fc5
//
// Each card emits a JSON island built by internal/panel/charts
// (Spec.JSON); this script reads it, resolves the categorical palette from
// the --chart-* CSS tokens, and draws the chart. Colors live in CSS so a
// light/dark swap recolors every chart and the matching legend dots with
// no server round-trip. No framework, no build step (cf. widgets.js).

(function () {
  'use strict';

  // palette reads --chart-1..8 off :root so the active theme decides the
  // hues. Index 0 of the returned array is unused (tokens are 1-based).
  function palette() {
    var cs = getComputedStyle(document.documentElement);
    var hexes = [''];
    for (var i = 1; i <= 8; i++) {
      hexes.push((cs.getPropertyValue('--chart-' + i) || '').trim() || '#888888');
    }
    return hexes;
  }

  // colorAt cycles the 8-color palette (palette()[1..8]).
  function colorAt(hexes, i) {
    return hexes[1 + (((i % 8) + 8) % 8)];
  }

  // formatValue mirrors the Spec's prefix/suffix and groups thousands, so
  // tooltips read "$12.34", "1,500 tokens", "62%".
  function makeFormatter(spec) {
    var prefix = spec.valuePrefix || '';
    var suffix = spec.valueSuffix || '';
    return function (value) {
      var n = Number(value);
      var body;
      if (!isFinite(n)) {
        body = String(value);
      } else if (Math.abs(n - Math.round(n)) < 1e-9) {
        body = n.toLocaleString();
      } else {
        body = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      }
      return prefix + body + suffix;
    };
  }

  function renderChart(container, hexes) {
    if (!window.frappe || !frappe.Chart) return;
    var id = container.getAttribute('data-chart');
    var island = document.querySelector('script.chart-spec[data-for="' + id + '"]');
    if (!island) return;
    var spec;
    try {
      spec = JSON.parse(island.textContent);
    } catch (_) {
      return;
    }
    if (!spec || !spec.datasets || !spec.datasets.length) return;

    // Slice charts color per value; axis charts color per dataset.
    var colors;
    if (spec.type === 'donut' || spec.type === 'pie') {
      var vals = (spec.datasets[0] && spec.datasets[0].values) || [];
      colors = vals.map(function (_v, i) { return colorAt(hexes, i); });
    } else {
      colors = spec.datasets.map(function (_d, i) { return colorAt(hexes, i); });
    }

    var fmt = makeFormatter(spec);

    // On re-render (e.g. a theme flip) detach the whole previous subtree
    // at once by swapping in an empty clone, instead of surgically
    // clearing the container. Frappe animates with requestAnimationFrame
    // and removes its own nodes on the next tick; clearing the container
    // under it would orphan those nodes mid-flight and throw. Detaching
    // the entire container keeps its inner nodes intact (just orphaned),
    // so the stale animation frame is a harmless no-op.
    var target = container;
    if (container.__chart) {
      target = container.cloneNode(false); // keeps data-chart + class, drops children
      container.replaceWith(target);
    }

    // Dense series (daily buckets over a month+) read better as a clean
    // line; dots at every point turn it into a string of beads. Tooltips
    // don't need the dots either way.
    var dense = (spec.labels || []).length > 24;

    target.__chart = new frappe.Chart(target, {
      data: { labels: spec.labels || [], datasets: spec.datasets },
      type: spec.type,
      height: spec.height || 160,
      animate: 1,
      colors: colors,
      // xAxisMode 'tick' keeps short ticks under the labels instead of a
      // full-height vertical gridline per label.
      axisOptions: { xIsSeries: true, xAxisMode: 'tick', shortenYAxisNumbers: 1 },
      barOptions: { stacked: spec.stacked ? 1 : 0, spaceRatio: 0.4 },
      lineOptions: { regionFill: spec.regionFill ? 1 : 0, hideDots: dense ? 1 : 0, dotSize: 3 },
      tooltipOptions: { formatTooltipY: fmt },
    });
  }

  // paintLegends colors the hand-rolled HTML legend dots from the same
  // palette + index the chart used, so legend and chart never drift.
  function paintLegends(root, hexes) {
    root.querySelectorAll('.cost-legend-dot[data-ci]').forEach(function (dot) {
      var i = parseInt(dot.getAttribute('data-ci'), 10) || 0;
      dot.style.background = colorAt(hexes, i);
    });
  }

  function renderAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var hexes = palette();
    scope.querySelectorAll('[data-chart]').forEach(function (c) {
      renderChart(c, hexes);
    });
    paintLegends(scope, hexes);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { renderAll(document); });
  } else {
    renderAll(document);
  }

  // HTMX can swap a fragment carrying a chart; re-render whatever landed.
  document.addEventListener('htmx:afterSettle', function (ev) { renderAll(ev.target); });

  // Recolor in place when the theme attribute flips (e.g. a future global
  // toggle). Cheap: only fires on data-theme mutations.
  if (window.MutationObserver) {
    new MutationObserver(function () { renderAll(document); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
})();
