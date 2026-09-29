import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameCapture, captureScriptFile } from '../dist/code/browser/FrameCapture.js';

test('a between-callback hitch is recorded even when both CPU callbacks are cheap', () => {
  const capture = new FrameCapture(100);
  capture.frame(110, 111, 3, false);
  capture.frame(250, 252, 4, false);
  capture.finish(260);
  const report = capture.report();
  assert.equal(report.summary.intervals.worst, 140);
  assert.equal(report.summary.intervals.longFrames, 1);
  assert.equal(report.summary.cpu.worst, 4);
  assert.deepEqual(report.frames[0], [10, 11, 3, null, 0]);
  assert.deepEqual(report.frames[1], [150, 152, 4, 140, 0]);
});

test('slow CPU work remains on the previous frame rather than being assigned to the following gap', () => {
  const capture = new FrameCapture(0);
  capture.frame(10, 11, 140, false);
  capture.frame(160, 161, 3, false);
  capture.event('cpuSections', 11, { sections: { 'render.terrain': 130 } });
  capture.finish(170);
  const report = capture.report();
  assert.equal(report.frames[0][2], 140);
  assert.equal(report.frames[1][2], 3);
  assert.equal(report.frames[1][3], 150);
  assert.equal(report.events.cpuSections[0].atMs, 11);
});

test('hidden or inactive spans do not produce false multi-second hitches', () => {
  const capture = new FrameCapture(0);
  capture.frame(10, 11, 2, false);
  capture.frame(17, 18, 2, false);
  capture.breakCadence();
  capture.frame(5017, 5018, 2, false);
  capture.frame(5024, 5025, 2, false);
  capture.finish(5030);
  const report = capture.report();
  assert.equal(report.frames[2][3], null);
  assert.equal(report.summary.intervals.count, 2);
  assert.equal(report.summary.intervals.worst, 7);
});

test('recording is bounded, reports lost event coverage, and stops accepting data after finish', () => {
  const capture = new FrameCapture(0, 2);
  capture.frame(1, 2, 3, false);
  capture.frame(10, 11, 4, true);
  capture.frame(20, 21, 5, false);
  for (let i = 0; i < 250; i++) capture.event('longTasks', i, { durationMs: 60 });
  capture.finish(300);
  capture.event('longTasks', 301, { durationMs: 90 });
  const report = capture.report();
  assert.equal(report.frames.length, 2);
  assert.equal(report.frames[1][4], 1);
  assert.equal(report.frameLimitReached, true);
  assert.equal(report.events.longTasks.length, 240);
  assert.equal(report.droppedEvents.longTasks, 10);
  assert.equal(report.durationMs, 300);
  report.events.longTasks[0].durationMs = 999;
  assert.equal(capture.report().events.longTasks[0].durationMs, 60);
});

test('invalid/backwards samples and pre-capture events cannot pollute statistics', () => {
  const capture = new FrameCapture(100);
  capture.frame(101, 102, NaN, false);
  capture.frame(101, 102, -1, false);
  capture.frame(101, 102, 2, false);
  capture.frame(101, 102, 2, false);
  capture.frame(100, 102, 2, false);
  capture.event('longTasks', 90, { durationMs: 200 });
  capture.finish(110);
  const report = capture.report();
  assert.equal(report.summary.cpu.count, 1);
  assert.equal(report.summary.intervals.count, 0);
  assert.deepEqual(report.events, {});
});

test('script attribution excludes credentials, host, directories and URL parameters', () => {
  assert.equal(captureScriptFile('http://user:secret@localhost:5173/src/browser/Terrain.ts?token=secret#secret'), 'Terrain.ts');
  assert.equal(captureScriptFile('data:text/javascript,secret'), 'unavailable');
  assert.equal(captureScriptFile('file:///C:/private/secret.js'), 'unavailable');
  assert.equal(captureScriptFile(''), 'unavailable');
});

test('a sustained slow scene cannot crowd later severe hitches out of section attribution', () => {
  const capture = new FrameCapture(100);
  for (let index = 0; index < 240; index++) capture.event('cpuSections', 100 + index * 25,
    { cpuMs: 25, sections: { 'render.submit': 19 } });
  capture.event('cpuSections', 20100, { cpuMs: 180, sections: { 'render.submit': 170 } });
  capture.event('cpuSections', 30100, { cpuMs: 20, sections: { 'render.submit': 10 } });
  capture.event('cpuSections', 40100, { cpuMs: 120, sections: { 'render.units': 110 } });
  capture.finish(60100);
  const report = capture.report();
  assert.equal(report.events.cpuSections.length, 240);
  assert.equal(report.droppedEvents.cpuSections, 3);
  assert.equal(report.events.cpuSections.at(-2).sections['render.submit'], 170);
  assert.equal(report.events.cpuSections.at(-1).atMs, 40000);
  assert.equal(report.events.cpuSections.some(event => event.cpuMs === 20), false);
  assert.match(report.eventSelection.cpuSections, /slowest/);
  report.events.cpuSections.at(-1).sections['render.units'] = 0;
  assert.equal(capture.report().events.cpuSections.at(-1).sections['render.units'], 110);
});

test('HUD steps, slow packets and long animation frames also keep their largest entries once full', () => {
  const capture = new FrameCapture(0);
  for (let index = 0; index < 240; index++) {
    capture.event('frameXmlSteps', 1 + index, { stepMs: 5 });
    capture.event('slowPackets', 1 + index, { opcode: 1, ms: 4 });
  }
  capture.event('frameXmlSteps', 5000, { stepMs: 90 });
  capture.event('slowPackets', 6000, { opcode: 0x1f6, ms: 70 });
  capture.event('frameXmlSteps', 7000, { stepMs: 1 });
  capture.finish(8000);
  const report = capture.report();
  assert.equal(report.events.frameXmlSteps.length, 240);
  assert.equal(report.events.frameXmlSteps.at(-1).stepMs, 90);
  assert.equal(report.events.slowPackets.at(-1).opcode, 0x1f6);
  assert.equal(report.droppedEvents.frameXmlSteps, 2);
  assert.match(report.eventSelection.frameXmlSteps, /largest stepMs/);
});
