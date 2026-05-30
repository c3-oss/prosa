// SSE client: connects to /events and bumps the "new sessions" badge
// when the server NOTIFYs that a session was inserted/updated.
(function () {
  if (typeof EventSource === "undefined") return;
  var es = new EventSource("/events");
  var badge = document.getElementById("new-sessions-count");
  var count = 0;
  function repaint() {
    if (!badge) return;
    if (count === 0) {
      badge.textContent = "0";
      badge.classList.add("zero");
    } else {
      badge.textContent = String(count);
      badge.classList.remove("zero");
    }
  }
  es.addEventListener("session.changed", function () {
    count += 1;
    repaint();
  });
  es.onerror = function () {
    // EventSource auto-reconnects; just log.
    console.warn("SSE connection lost; will retry");
  };
  // Reset badge when the user reloads or clicks the brand.
  var brand = document.querySelector(".brand");
  if (brand) {
    brand.addEventListener("click", function () {
      count = 0;
      repaint();
    });
  }
  repaint();
})();
