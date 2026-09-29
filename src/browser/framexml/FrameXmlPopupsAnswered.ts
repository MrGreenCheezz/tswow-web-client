/**
 * Which server questions this client has already answered, and how, whichever surface answered.
 *
 * `WorldClient` clears most pending requests the moment they are answered (a group, guild or arena
 * invite, a duel, a resurrection, a summon), so a second answer finds nothing to send. A ready check
 * is the exception: `answerReadyCheck` keeps `readyCheck` (the leader still collects answers on it)
 * and the server echoes a member's own answer only to the leader and assistants
 * (`Group::BroadcastReadyCheck`, GroupHandler.cpp:718). Neither the native prompt nor the stock
 * ReadyCheckFrame can therefore tell from the world that the other one already answered — and the
 * two change hands whenever the stock popup owner is published or torn down. Both record the answer
 * here, keyed by the world's own request object, so the second surface never asks again and the
 * player's own frame can still show the answer given.
 */
const answered = new WeakMap<object, boolean>();

export function markFrameXmlPopupAnswered(request: object, answer: boolean): void {
  answered.set(request, answer);
}

/** The answer given to `request`, or undefined while nobody has answered it. */
export function frameXmlPopupAnswer(request: object | undefined): boolean | undefined {
  return request === undefined ? undefined : answered.get(request);
}
