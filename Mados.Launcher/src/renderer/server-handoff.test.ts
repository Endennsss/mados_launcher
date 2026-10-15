// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { playServerHandoff, queueServerHandoff } from "./server-handoff";

afterEach(() => { document.body.replaceChildren(); document.documentElement.classList.remove("reduce-motion"); });
function elements() {
  const card = document.createElement("div"); card.dataset.serverAddress = "ss14://station.example";
  const mark = document.createElement("span"); mark.className = "server-mark"; card.append(mark); document.body.append(card);
  const target = document.createElement("div"); document.body.append(target);
  mark.getBoundingClientRect = () => new DOMRect(100, 100, 32, 32);
  target.getBoundingClientRect = () => new DOMRect(600, 100, 54, 54);
  target.animate = vi.fn();
  return {card,target};
}
it("never animates an unrelated server or a handoff disabled by reduced motion", () => {
  const {card,target} = elements();
  queueServerHandoff("ss14://station.example", card, "details");
  expect(playServerHandoff("ss14://different.example", "details", target)).toBeNull();
  document.documentElement.classList.add("reduce-motion");
  queueServerHandoff("ss14://station.example", card, "details");
  expect(playServerHandoff("ss14://station.example", "details", target)).toBeNull();
  expect(document.querySelector(".server-handoff-flight")).toBeNull();
});
it("cleans up the flight when its destination unmounts and consumes it only once", () => {
  const {card,target} = elements();
  const animation = {cancel:vi.fn(),onfinish:null};
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  Object.defineProperty(HTMLElement.prototype, "animate", {configurable:true,value:vi.fn(() => animation)});
  try {
    queueServerHandoff("ss14://station.example", card, "launch");
    const dispose = playServerHandoff("ss14://station.example", "launch", target);
    expect(document.querySelector(".server-handoff-flight")).not.toBeNull();
    expect(playServerHandoff("ss14://station.example", "launch", target)).toBeNull();
    dispose?.(); expect(document.querySelector(".server-handoff-flight")).toBeNull(); expect(animation.cancel).toHaveBeenCalled();
  } finally { if (previous) Object.defineProperty(HTMLElement.prototype, "animate", previous); else Reflect.deleteProperty(HTMLElement.prototype, "animate"); }
});
