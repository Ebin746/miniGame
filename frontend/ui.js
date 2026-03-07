// ── Responsive canvas scaling (zoomed in more) ──────────────
const arenaWrap = document.getElementById('arena-wrap');
const serverUrlInput = document.getElementById('server-url-input');
const CANVAS_W = 1200, CANVAS_H = 800;

// Auto-populate server address
if (window.location.hostname) {
    // If port is not 80 or 443, include it
    const host = window.location.host || 'localhost:8000';
    serverUrlInput.value = host;
}

function rescale() {
    const maxW = window.innerWidth - 32;
    const maxH = window.innerHeight - 120; // Allow more height usage

    // Calculate scale to fit width or height
    let scale = Math.min(maxW / CANVAS_W, maxH / CANVAS_H);

    // Allow scaling up to 2.0 to fill larger screens
    scale = Math.min(2.0, Math.max(0.4, scale));

    arenaWrap.style.transform = `scale(${scale})`;

    // Adjust margin to handle the transform's whitespace
    const scaledH = CANVAS_H * scale;
    arenaWrap.style.marginBottom = `${(scaledH - CANVAS_H) + 20}px`;
}

window.addEventListener('resize', rescale);
rescale();
