import type { ModuleDependencies } from "../graph/module-dependencies.js";

/** The bundled UI's module graph response after validating this request's inputs. */
export type ModuleDependencyResponse = ModuleDependencies & {
  computedAt: string;
  fresh: true;
  mode: "verify";
  reason: string;
};
