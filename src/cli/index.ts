import { Command } from "commander";
import { registerNew } from "./commands/new.js";
import { registerNext } from "./commands/next.js";
import { registerGate } from "./commands/gate.js";
import { registerShow } from "./commands/show.js";
import { registerStatus } from "./commands/status.js";
import { registerAuth } from "./commands/auth.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerAdvise } from "./commands/advise.js";
import { registerSubmit } from "./commands/submit.js";
import { registerRetry } from "./commands/retry.js";
import { registerInit } from "./commands/init.js";
import { registerWatch } from "./commands/watch.js";
import { registerUpgrade } from "./commands/upgrade.js";
import { registerInvoke } from "./commands/invoke.js";

const program = new Command();
program
  .name("forge")
  .description("Multi-agent workflow orchestrator")
  .version("0.1.0");

registerNew(program);
registerNext(program);
registerGate(program);
registerShow(program);
registerStatus(program);
registerAuth(program);
registerDashboard(program);
registerAdvise(program);
registerSubmit(program);
registerRetry(program);
registerInit(program);
registerWatch(program);
registerUpgrade(program);
registerInvoke(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`forge: ${(err as Error).message}`);
  process.exit(1);
});
