import { OxyServer } from "@oxy.so/core/server";

/** One server client; bootstrap supplies the existing Allo service credential. */
export const oxyClient = new OxyServer({ baseURL: "https://api.oxy.so" });
