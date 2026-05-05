import { SealionEnv, type SealionEnvOptions } from "./env.ts";

export function make(opts: SealionEnvOptions): SealionEnv {
  return new SealionEnv(opts);
}
