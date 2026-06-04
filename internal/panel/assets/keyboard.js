// Lightweight keyboard nav shim. Avoids a SPA framework — just enough
// to satisfy INTENT §9: j/k move selection, Esc closes the side panel,
// / focuses the search input.
(function () {
  function rows() {
    return Array.from(document.querySelectorAll(".session-row"));
  }
  function activeIdx(list) {
    return list.findIndex((r) => r.classList.contains("active"));
  }
  function setActive(list, i) {
    list.forEach((r) => r.classList.remove("active"));
    if (i >= 0 && i < list.length) {
      list[i].classList.add("active");
      list[i].scrollIntoView({ block: "nearest" });
    }
  }
  function closeSidePanel() {
    var panel = document.querySelector("#side-panel");
    if (!panel || !panel.innerHTML.trim()) return;
    panel.innerHTML = "";
    var url = new URL(window.location);
    url.searchParams.delete("session");
    window.history.replaceState({}, "", url);
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") {
      if (ev.key === "Escape") ev.target.blur();
      return;
    }
    if (ev.key === "/") {
      var s = document.querySelector("#search");
      if (s) {
        ev.preventDefault();
        s.focus();
        return;
      }
      // No search input on this page — jump to /sessions where the FTS
      // input lives and let its autofocus take it from there.
      ev.preventDefault();
      window.location.href = "/sessions";
      return;
    }
    if (ev.key === "Escape") {
      closeSidePanel();
      return;
    }
    var list = rows();
    if (!list.length) return;
    var i = activeIdx(list);
    if (ev.key === "j") {
      ev.preventDefault();
      setActive(list, Math.min(list.length - 1, i + 1));
    } else if (ev.key === "k") {
      ev.preventDefault();
      setActive(list, Math.max(0, i - 1));
    } else if (ev.key === "Enter") {
      if (i >= 0) {
        ev.preventDefault();
        list[i].click();
      }
    }
  });
  document.addEventListener("click", function (ev) {
    var panel = document.querySelector("#side-panel");
    if (!panel || !panel.innerHTML.trim()) return;
    if (ev.target.closest(".sp-close")) {
      closeSidePanel();
      return;
    }
    if (ev.target.closest("#side-panel")) return;
    if (ev.target.closest('a[href*="session="]')) return;
    closeSidePanel();
  });
})();
