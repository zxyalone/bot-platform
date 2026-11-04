import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { realFactory } from "./factory.ts";
import { ensureSeedBots, Store } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const port = Number(process.env.PORT || 4317);
const store = new Store(process.env.BOT_PLATFORM_HOME || join(root, ".data"));
ensureSeedBots(store);

const app = createApp({ store, factory: realFactory, webDir: join(root, "src", "web"), port: () => port });
// Loopback only: this API can start agents with access to the user's files and accounts.
app.server.listen(port, "127.0.0.1", () => console.log(`Bot Platform: http://127.0.0.1:${port}`));

const quit = () => {
  app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
