// Puts a chosen light or dark theme on the page before it first paints, so it does not flash the other one.
// A file of its own, not inline: the page's policy runs only scripts from the server.
try {
  const theme = localStorage.getItem("tent-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
