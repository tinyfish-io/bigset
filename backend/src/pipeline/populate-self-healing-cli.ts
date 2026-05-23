import { runPopulateSelfHealingCli } from "./populate-self-healing-command.js";

process.exitCode = await runPopulateSelfHealingCli({
  argv: process.argv.slice(2),
  env: process.env,
});
