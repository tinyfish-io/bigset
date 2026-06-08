import CreateCommand from "./commands/create.js";
import ExportCommand from "./commands/export.js";
import ListCommand from "./commands/list.js";
import PopulateCommand from "./commands/populate.js";
import RowsCommand from "./commands/rows.js";
import StatusCommand from "./commands/status.js";
import StopCommand from "./commands/stop.js";

const commands = {
  create: CreateCommand,
  export: ExportCommand,
  list: ListCommand,
  populate: PopulateCommand,
  rows: RowsCommand,
  status: StatusCommand,
  stop: StopCommand,
};

function printHelp(): void {
  console.log(`BigSet CLI MVP

Usage:
  bigset <command> [args] [flags]

Commands:
  create <prompt>          Infer schema, create a dataset, and start populate
  list                     List local CLI-scoped datasets
  status <dataset-id>      Show dataset status
  rows <dataset-id>        Print dataset rows
  export <dataset-id>      Export dataset rows
  populate <dataset-id>    Start population for an existing dataset
  stop <dataset-id>        Stop a running populate/update

Run "bigset <command> --help" for command flags.`);
}

const [commandName, ...argv] = process.argv.slice(2);

if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
  printHelp();
  process.exit(0);
}

const command = commands[commandName as keyof typeof commands];
if (!command) {
  console.error(`Unknown command: ${commandName}`);
  printHelp();
  process.exit(1);
}

try {
  await command.run(argv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}
