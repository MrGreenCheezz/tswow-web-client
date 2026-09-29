import { ANIMATION_IDS, ANIMATION_BODY_FLAGS, ANIMATION_FALLBACK, EMOTE_ANIMATIONS } from "file:///F:/tswowRoot/WebClient/src/generated/client-data/animations.ts";
const re = new RegExp(process.argv[2] ?? "^(Sleep|Kneel|JumpLand|JumpEnd|Sheath|HipSheath|Attack|Ready|Parry|Shield|Dodge|Stun|Loot|Wound|CombatWound|CombatCritical|Special|Emote(State|Work|Ready|Hold)|Fidget|Stand|MountSpecial|Custom|Cannibalize|Salute|Fall|Death|Dead|Drown|Sit)", "i");
const out = [];
for (const [name, id] of Object.entries(ANIMATION_IDS)) if (re.test(name)) out.push(`${id}:${name}${ANIMATION_BODY_FLAGS[id] !== undefined ? `/f${ANIMATION_BODY_FLAGS[id].toString(16)}` : ""}${ANIMATION_FALLBACK[id] !== undefined ? `>${ANIMATION_FALLBACK[id]}` : ""}`);
out.sort((a, b) => parseInt(a) - parseInt(b));
console.log(out.join(" "));
const states = Object.entries(EMOTE_ANIMATIONS).filter(([, v]) => v.state).map(([k, v]) => `${k}->${v.animation}`);
console.log("EMOTE_ANIMATIONS states:", states.join(" "));
console.log("EMOTE_ANIMATIONS count", Object.keys(EMOTE_ANIMATIONS).length);
