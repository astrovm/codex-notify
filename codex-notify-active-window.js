const activeWindow = workspace.activeWindow;

callDBus(
    "io.codex.Notify.ActiveWindow",
    "/ActiveWindow",
    "io.codex.Notify.ActiveWindow",
    "Report",
    activeWindow ? String(activeWindow.resourceClass) : "",
    activeWindow ? String(activeWindow.caption) : "",
    activeWindow ? String(activeWindow.pid) : ""
);
