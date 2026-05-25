import { Command } from "commander";
import { version } from "../../package.json" with { type: "json" };
import { registerNew } from "./commands/new.js";
import { registerNext } from "./commands/next.js";
import { registerGate } from "./commands/gate.js";
import { registerShow } from "./commands/show.js";
import { registerStatus } from "./commands/status.js";
import { registerAuth } from "./commands/auth.js";
import { registerAdvise } from "./commands/advise.js";
import { registerRetry } from "./commands/retry.js";
import { registerInit } from "./commands/init.js";
import { registerWatch } from "./commands/watch.js";
import { registerUpgrade } from "./commands/upgrade.js";
import { registerInvoke } from "./commands/invoke.js";
import { registerBacklog } from "./commands/backlog.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerNotify } from "./commands/notify.js";

const program = new Command();
program
  .name("forge")
  .description("Multi-agent workflow orchestrator")
  .version(version);

registerNew(program);
registerNext(program);
registerGate(program);
registerShow(program);
registerStatus(program);
registerAuth(program);
registerAdvise(program);
registerRetry(program);
registerInit(program);
registerWatch(program);
registerUpgrade(program);
registerInvoke(program);
registerBacklog(program);
registerDashboard(program);
registerNotify(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`forge: ${(err as Error).message}`);
  process.exit(1);
});
