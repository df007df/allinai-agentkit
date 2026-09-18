import type { HubStore } from "../hub/index.js";

export type DemoSiteOptions = {
  port?: number;
  host?: string;
  /** 默认内存 Store；传入自定义实现即可替换持久化（见官网「替换内存 Hub」）。 */
  store?: HubStore<string>;
};
