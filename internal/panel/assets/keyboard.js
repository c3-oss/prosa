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
      }
      return;
    }
    if (ev.key === "Escape") {
      var panel = document.querySelector("#side-panel");
      if (panel) panel.innerHTML = "";
      var url = new URL(window.location);
      url.searchParams.delete("session");
      window.history.replaceState({}, "", url);
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
})();
