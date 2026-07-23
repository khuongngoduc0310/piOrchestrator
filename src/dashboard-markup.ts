export const DASHBOARD_DOCUMENT_START = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>piOrchestrator</title>
<style>
`;

export const DASHBOARD_MARKUP = `
</style>
</head>
<body>
<a href="#overview" class="skip-link">Skip to current activity</a>
<div class="shell">
<header>
<div class="header-main">
<span class="product-name">piOrchestrator</span>
<span id="status-badge" class="status-badge idle">Idle</span>
<span id="connection-badge" class="connection-badge connecting">Connecting</span>
<span id="elapsed-display" class="elapsed"></span>
<span id="run-id-display" class="run-id muted"></span>
</div>
<div id="request-display" class="request" role="status"></div>
<div class="run-controls"><label for="run-picker">Run history</label><select id="run-picker" aria-label="Select workflow run"><option>Loading runs…</option></select><button id="refresh-runs" class="close-btn" type="button">Refresh</button></div>
</header>
<nav id="section-nav" aria-label="Dashboard sections" hidden>
<a href="#overview" class="section-link" aria-current="location">Overview</a>
<a href="#agents" class="section-link">Agents</a>
<a href="#timeline" class="section-link">Timeline</a>
<a href="#artifacts" class="section-link">Artifacts</a>
</nav>
<main>
<section id="overview" aria-label="Current overview" tabindex="-1">
<div id="callout" role="status" aria-live="polite"></div>
<div id="phases"></div>
<div class="overview-grid">
<div id="activity" class="panel"><div class="empty-state"><p>Loading activity…</p></div></div>
<div id="run-details" class="panel"><div class="empty-state"><p>Loading details…</p></div></div>
</div>
</section>
<section id="agents" aria-label="Agents" tabindex="-1">
<h2 class="section-heading">Agents</h2>
<div class="agents-layout">
<div id="agent-grid" class="agent-grid" role="group"></div>
<div id="agent-inspector" class="agent-inspector panel" hidden><div class="empty-state"><p>Select an agent to inspect</p></div></div>
</div>
</section>
<section id="timeline" aria-label="Timeline" tabindex="-1">
<h2 class="section-heading">Timeline</h2>
<div id="timeline-entries" role="list"></div>
</section>
<section id="artifacts" aria-label="Artifacts" tabindex="-1">
<h2 class="section-heading">Recent Artifacts</h2>
<div id="artifact-list" class="artifact-list"></div>
<div id="artifact-viewer" class="artifact-viewer panel" hidden></div>
</section>
</main>
</div>
<script>
`;

export const DASHBOARD_DOCUMENT_END = `
</script>
</body>
</html>`;
