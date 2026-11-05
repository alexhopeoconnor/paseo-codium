import type { PluginServerContext } from "@getpaseo/plugin/server";
import { codiumSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(codiumSettings);
  return () => {};
}
