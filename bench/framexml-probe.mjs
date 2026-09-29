// FrameXML frame cost in headless Chrome: the dev page (`framexml.html?toc=vertical`, the file set
// the world mount loads, against the canned world) with Long Animation Frame capture.
//
//   node bench/framexml-probe.mjs [--url http://127.0.0.1:5173/framexml.html?toc=vertical]
//     [--seconds 10] [--hover ActionButton1] [--open CharacterMicroButton] [--label name]
//
// Prints per-frame rAF interval, main-thread script time and forced style/layout from LoAF entries
// (Chrome's own attribution), grouped by the function that ran. Needs the Vite dev server and the
// local gateway; it opens no game connection.
import { writeFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = option('url', 'http://127.0.0.1:5173/framexml.html?toc=vertical');
const seconds = Number(option('seconds', '10'));
const hover = option('hover', undefined);
const open = option('open', undefined);
const label = option('label', 'framexml');
const profile = args.includes('--profile');

const browser = await puppeteer.launch({
  executablePath: process.env.BENCH_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--window-size=1920,919'],
  defaultViewport: { width: 1920, height: 919 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.evaluateOnNewDocument(() => {
    window.__loaf = [];
    window.__recording = false;
    new PerformanceObserver((list) => {
      if (!window.__recording) return;
      for (const entry of list.getEntries()) {
        window.__loaf.push({
          duration: entry.duration,
          blocking: entry.blockingDuration,
          render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0,
          styleAndLayout: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
          scripts: entry.scripts.map((script) => ({
            name: `${script.invokerType}:${script.invoker}`.slice(0, 80),
            source: `${script.sourceFunctionName || '(anon)'} ${String(script.sourceURL).split('/').at(-1)}:${script.sourceCharPosition}`,
            duration: script.duration,
            forced: script.forcedStyleAndLayoutDuration,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
    window.__intervals = [];
    let last = 0;
    const tick = (now) => {
      if (window.__recording && last) window.__intervals.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const started = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => typeof window.frameXmlDiagnostics === 'function'
    && window.frameXmlDiagnostics().live.frames > 30, { timeout: 180000, polling: 250 });
  const bootMs = Date.now() - started;
  if (open) {
    const opened = await page.evaluate((name) => window.frameXmlClick(name), open);
    console.log('open', open, opened);
  }
  if (hover) {
    const box = await page.evaluate((name) => {
      const element = document.querySelector(`[data-framexml-name="${name}"]`) ?? document.getElementById(name);
      const rect = element?.getBoundingClientRect();
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : undefined;
    }, hover);
    if (box) await page.mouse.move(box.x, box.y);
    console.log('hover', hover, box ? 'ok' : 'element not found');
  }
  // Dev-server builds share module instances with `import()`, so the public entry points can be
  // timed without touching the sources: every renderer sync and every bridge tick.
  await page.evaluate(async () => {
    // The URL the page itself loaded, query and all: after a hot update a bare path is a second module.
    const loaded = (file) => performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes(file)) ?? file;
    const renderer = await import(loaded('/src/browser/ui/framexml_compat/FrameXmlDomRenderer.ts'));
    const runtime = await import(loaded('/src/browser/ui/framexml_compat/FrameXmlRuntime.ts'));
    const timed = (proto, name) => {
      const original = proto[name];
      window.__timing[name] = { calls: 0, ms: 0 };
      proto[name] = function (...values) {
        if (!window.__recording) return original.apply(this, values);
        const start = performance.now();
        try { return original.apply(this, values); } finally {
          window.__timing[name].calls++; window.__timing[name].ms += performance.now() - start;
        }
      };
    };
    window.__timing = {};
    timed(renderer.FrameXmlDomRenderer.prototype, 'sync');
    timed(renderer.FrameXmlDomRenderer.prototype, 'tickCooldowns');
    timed(renderer.FrameXmlDomRenderer.prototype, 'measure');
    timed(runtime.FrameXmlUiBridge.prototype, 'tick');
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const cdp = profile ? await page.target().createCDPSession() : undefined;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  await page.evaluate(() => { window.__recording = true; });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const result = await page.evaluate(() => {
    window.__recording = false;
    return { loaf: window.__loaf, intervals: window.__intervals, timing: window.__timing, diagnostics: window.frameXmlDiagnostics().live };
  });
  if (cdp) {
    const { profile: cpuProfile } = await cdp.send('Profiler.stop');
    await mkdir('bench/results/framexml', { recursive: true });
    await writeFile(`bench/results/framexml/${label}.cpuprofile`, JSON.stringify(cpuProfile));
  }
  const intervals = [...result.intervals].sort((a, b) => a - b);
  const pick = (q) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * q))] ?? 0;
  const mean = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
  const bySource = new Map();
  let scriptMs = 0, forcedMs = 0, layoutMs = 0;
  for (const frame of result.loaf) {
    layoutMs += frame.styleAndLayout;
    for (const script of frame.scripts) {
      scriptMs += script.duration; forcedMs += script.forced;
      const row = bySource.get(script.source) ?? { count: 0, duration: 0, forced: 0 };
      row.count++; row.duration += script.duration; row.forced += script.forced;
      bySource.set(script.source, row);
    }
  }
  const frames = Math.max(1, intervals.length);
  const summary = {
    label, url, bootMs, seconds, frames: intervals.length,
    fps: 1000 / mean, intervalMean: mean, intervalP50: pick(0.5), intervalP95: pick(0.95), intervalP99: pick(0.99),
    longFrames: result.loaf.length,
    timing: Object.fromEntries(Object.entries(result.timing).map(([name, row]) => [name, {
      callsPerFrame: +(row.calls / Math.max(1, intervals.length)).toFixed(2), msPerFrame: +(row.ms / Math.max(1, intervals.length)).toFixed(3) }])),
    perFrame: { scriptMs: scriptMs / frames, forcedLayoutMs: forcedMs / frames, renderStyleLayoutMs: layoutMs / frames },
    top: [...bySource].sort((a, b) => b[1].duration - a[1].duration).slice(0, 12)
      .map(([source, row]) => ({ source, count: row.count, msPerFrame: +(row.duration / frames).toFixed(2), forcedPerFrame: +(row.forced / frames).toFixed(2) })),
    errors: errors.slice(0, 10),
  };
  console.log(JSON.stringify(summary, null, 2));
  await mkdir('bench/results/framexml', { recursive: true });
  await writeFile(`bench/results/framexml/${new Date().toISOString().replaceAll(':', '-')}-${label}.json`, JSON.stringify({ summary, loaf: result.loaf }, null, 1));
} finally {
  await browser.close();
}
