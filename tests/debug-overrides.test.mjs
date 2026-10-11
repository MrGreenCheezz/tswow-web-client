// The debug pane's forced time of day and weather (game/DebugOverrides.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DebugTimeOverride, DebugWeatherOverride, parseDebugHour,
} from '../dist/code/browser/game/DebugOverrides.js';

const server = { minuteOfDay: 600, minutesPerSecond: 1 / 60, weekday: 3, date: { year: 2026, month: 10, day: 11 } };

test('with nothing forced the frame gets the server clock itself', () => {
  const clock = new DebugTimeOverride();
  assert.equal(clock.active, false);
  assert.equal(clock.apply(server, 1000), server, 'same object, so nothing downstream sees a change');
  assert.equal(clock.apply(undefined, 1000), undefined);
});

test('a set time holds still and keeps the rest of the server clock', () => {
  const clock = new DebugTimeOverride();
  clock.setMinute(21 * 60, 1000);
  const later = clock.apply(server, 61_000);
  assert.equal(later.minuteOfDay, 21 * 60, 'a first forced time is held still');
  assert.equal(later.weekday, 3);
  assert.deepEqual(later.date, server.date);
  assert.equal(server.minuteOfDay, 600, 'the server object is not written');
});

test('a running clock advances from the minute on screen and wraps at midnight', () => {
  const clock = new DebugTimeOverride();
  clock.setMinute(23 * 60 + 50, 0);
  clock.setSpeed(10, 0, server);
  assert.equal(clock.minuteAt(2000), 10, '23:50 plus twenty minutes is 00:10');
  // A change of pace re-anchors where the clock stands: no jump.
  const before = clock.minuteAt(3000);
  clock.setSpeed(0, 3000, server);
  assert.equal(clock.minuteAt(3000), before);
  assert.equal(clock.minuteAt(90_000), before);
  // A set time keeps the pace that was chosen.
  clock.setSpeed(1, 100_000, server);
  clock.setMinute(6 * 60, 100_000);
  assert.equal(clock.minuteAt(160_000), 6 * 60 + 60);
});

test('speeding up the server clock starts from the server minute', () => {
  const clock = new DebugTimeOverride();
  clock.setSpeed(60, 5000, server);
  assert.equal(clock.minuteAt(5000), 600);
  assert.equal(clock.minuteAt(6000), 660);
  clock.setSpeed(-1, 6000, server);
  clock.setSpeed(Number.NaN, 6000, server);
  assert.equal(clock.speed, 60, 'a negative or NaN pace is refused');
  clock.clear();
  assert.equal(clock.apply(server, 7000), server);
});

test('a forced clock makes a time even before the server has sent one', () => {
  const clock = new DebugTimeOverride();
  clock.setMinute(300, 0);
  const time = clock.apply(undefined, 0);
  assert.equal(time.minuteOfDay, 300);
  assert.ok(time.minutesPerSecond > 0);
});

test('forced weather is one object per change, and clear gives the server packet back', () => {
  const weather = new DebugWeatherOverride();
  const packet = { state: 0, intensity: 0, abrupt: true };
  assert.equal(weather.apply(packet), packet);
  weather.set(4, 0.8);
  const first = weather.apply(packet);
  assert.deepEqual(first, { state: 4, intensity: 0.8, abrupt: false });
  weather.set(4, 0.8);
  assert.equal(weather.apply(packet), first, 'the same choice is the same packet: no fade restarts');
  weather.set(4, 3);
  assert.equal(weather.apply(packet).intensity, 1, 'intensity is clamped');
  weather.set(0, 0.9);
  assert.equal(weather.apply(packet).intensity, 0, 'a clear sky has no intensity');
  weather.set(-1, 0.5);
  weather.set(1.5, 0.5);
  assert.equal(weather.state, 0, 'nonsense states are ignored');
  weather.clear();
  assert.equal(weather.apply(packet), packet);
  assert.equal(weather.apply(undefined), undefined);
});

test('hours parse from numbers and clock text', () => {
  assert.equal(parseDebugHour(13.5), 810);
  assert.equal(parseDebugHour(25), 60);
  assert.equal(parseDebugHour('21:30'), 1290);
  assert.equal(parseDebugHour('6,5'), 390);
  assert.equal(parseDebugHour('24:00'), undefined);
  assert.equal(parseDebugHour(''), undefined);
  assert.equal(parseDebugHour('утро'), undefined);
});
