(function () {
  var choice = "light";
  try { choice = localStorage.getItem("aim-theme") || "light"; } catch { /* storage may be disabled */ }
  var mode = choice === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
  document.documentElement.dataset.themeChoice = choice;
})();
