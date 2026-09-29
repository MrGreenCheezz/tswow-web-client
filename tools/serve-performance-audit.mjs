// Local-only production preview with an opt-in, visible measurement panel. No game code changes.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/web');
const port = Number(process.argv[3] ?? 4185);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

function probe() {
  let recording = false;
  const supportsLongTasks = typeof PerformanceObserver === 'function'
    && PerformanceObserver.supportedEntryTypes.includes('longtask');
  const callbackCpu = new Map();
  const contexts = new Set();
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => nativeRaf((time) => {
    if (!recording) return callback(time);
    const start = performance.now();
    try { return callback(time); }
    finally { callbackCpu.set(time, (callbackCpu.get(time) ?? 0) + performance.now() - start); }
  });
  const nativeContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = nativeContext.apply(this, args);
    if (context && (args[0] === 'webgl2' || args[0] === 'webgl')) contexts.add(context);
    return context;
  };
  const distribution = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return { count: sorted.length, p50: percentile(.5), p95: percentile(.95),
      p99: percentile(.99), max: sorted.at(-1) ?? null,
      over50ms: sorted.filter(v => v > 50).length,
      over50msTotal: sorted.filter(v => v > 50).reduce((a, b) => a + b, 0) };
  };
  const conditions = () => ({
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null, viewport: [innerWidth, innerHeight],
    devicePixelRatio, visibility: document.visibilityState,
    longTasksSupported: supportsLongTasks,
    canvases: [...document.querySelectorAll('canvas')].map(c => ({ id: c.id,
      css: [c.clientWidth, c.clientHeight], backing: [c.width, c.height] })),
    webgl: [...contexts].map(gl => {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { version: gl.getParameter(gl.VERSION), renderer: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        antialias: gl.getContextAttributes()?.antialias,
        gpuTime: 'unavailable (preview observer does not issue GPU queries)' };
    }),
    heap: performance.memory ? { usedBytes: performance.memory.usedJSHeapSize,
      totalBytes: performance.memory.totalJSHeapSize } : null,
  });
  window.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('details');
    panel.id = 'performance-audit';
    panel.style.cssText = 'position:fixed;bottom:0;right:0;z-index:2147483647;background:#111;color:#eee;padding:6px;max-width:600px;max-height:50vh;overflow:auto;font:12px monospace';
    const summary = document.createElement('summary');
    summary.textContent = 'Performance audit (local preview)';
    const button = document.createElement('button');
    button.textContent = 'Record 10 seconds';
    const output = document.createElement('pre');
    output.id = 'performance-audit-result';
    output.style.whiteSpace = 'pre-wrap';
    const results = [];
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Recording…';
      callbackCpu.clear();
      const before = conditions();
      const startedAt = performance.now();
      const intervals = [];
      const longTasks = [];
      let observer;
      if (supportsLongTasks) {
        observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
        observer.observe({ type: 'longtask' });
      }
      recording = true;
      let previous;
      const sample = (time) => {
        if (previous !== undefined) intervals.push(time - previous);
        previous = time;
        if (time - startedAt < 10_000) { nativeRaf(sample); return; }
        recording = false;
        observer?.disconnect();
        results.push({ run: results.length + 1, url: location.pathname + location.search,
          durationMs: time - startedAt, before, after: conditions(),
          rafIntervalsMs: distribution(intervals), rafCallbackCpuMs: distribution([...callbackCpu.values()]),
          longTasksMs: supportsLongTasks ? distribution(longTasks) : null,
          navigation: performance.getEntriesByType('navigation').map(n => ({
            domContentLoadedMs: n.domContentLoadedEventEnd, loadMs: n.loadEventEnd,
            transferBytes: n.transferSize })),
          resources: { count: performance.getEntriesByType('resource').length,
            transferBytes: performance.getEntriesByType('resource').reduce((n,r) => n + r.transferSize,0) },
          limitations: 'RAF cadence and summed callback CPU are distinct; other tasks, compositor/GPU work and exact VRAM are not measured. Startup cache state is not controlled. Fixed settings must be recorded separately.' });
        output.textContent = JSON.stringify(results, null, 2);
        button.disabled = false;
        button.textContent = 'Record 10 seconds';
      };
      nativeRaf(sample);
    });
    panel.append(summary, button, output);
    document.body.append(panel);
  }, { once: true });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/__performance_audit.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store',
        'Cross-Origin-Embedder-Policy': 'credentialless' });
      response.end(`(${probe.toString()})();`);
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    let body = await readFile(path);
    if (extname(path) === '.html') body = Buffer.from(body.toString().replace('<head>', '<head><script src="/__performance_audit.js"></script>'));
    // Cross-origin isolated like the dev server (vite.config.mjs): the crowd pose worker needs it.
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless' });
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end('Preview request failed');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Audit preview: http://127.0.0.1:${port} (${root})`));
