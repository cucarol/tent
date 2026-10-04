import { readStored, writeStored } from "../util.js";

const KEY = "tent-actor-name";

/** The name this browser signs saves and confirmations with; empty leaves it to the service's OS user. */
export const actorName = (): string => readStored<string>(KEY, "").trim();

export function setActorName(name: string) {
  writeStored(KEY, name.trim());
}

/** The OKF actor sent as `by`, or undefined so the service records `human:<OS user>`. */
export function actorBy(): string | undefined {
  const name = actorName();
  return name ? `human:${name}` : undefined;
}
