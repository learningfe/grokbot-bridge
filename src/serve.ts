import fs from "node:fs";
import path from "node:path";
import { Bridge } from "./bridge.js";
import { loadConfig, sameIdentity, type AppConfig } from "./config.js";
import { FeishuChannel } from "./feishu.js";
import { startHttp } from "./http-api.js";
import { createLogger } from "./log.js";
import { Store } from "./store.js";

export async function serve(configPath: string): Promise<void> {
  const resolved = path.resolve(configPath);
  const config = loadConfig(resolved);
  const log = createLogger();
  const store = Store.open(config.dataDir);
  const channel = new FeishuChannel({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
    ...(config.feishu.botOpenId ? { botOpenId: config.feishu.botOpenId } : {}),
    log,
  });
  const bridge = new Bridge(config, store, channel, log);
  const httpServer = await startHttp({
    host: config.http.host,
    port: config.http.port,
    ...(config.http.token ? { token: config.http.token } : {}),
    api: bridge,
  });
  log.info(`listening on http://${config.http.host}:${config.http.port}`);
  bridge.restore();
  await channel.start({
    onMessage: (message) => bridge.onMessage(message),
    onRecall: (messageId) => bridge.onRecall(messageId),
  });
  log.info(`feishu bot ${channel.botOpenId}`);
  const watcher = watchConfig(resolved, config, bridge, log);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    watcher.close();
    await httpServer.close();
    await channel.stop();
  };
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });
}

function watchConfig(
  file: string,
  started: AppConfig,
  bridge: Bridge,
  log: ReturnType<typeof createLogger>,
): { close(): void } {
  let timer: NodeJS.Timeout | undefined;
  const reload = (): void => {
    try {
      const next = loadConfig(file);
      if (!sameIdentity(started.identity, next.identity)) {
        log.warn(
          "config identity changed (feishu app, bot open_id, http bind, token, or data dir); restart to apply it",
        );
      }
      bridge.replaceConfig({
        ...next,
        feishu: {
          appId: started.feishu.appId,
          appSecret: started.feishu.appSecret,
          domain: started.feishu.domain,
          ...(started.feishu.botOpenId ? { botOpenId: started.feishu.botOpenId } : {}),
        },
        http: started.http,
        dataDir: started.dataDir,
        identity: started.identity,
      });
      log.info("reloaded routes, allowlists, bots, and limits");
    } catch (error) {
      log.error(`config reload failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };
  const watcher = fs.watch(path.dirname(file), () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, 200);
  });
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
