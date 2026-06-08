import { Args, Command, Flags } from "@oclif/core";
import { getDataset, getRows } from "../client.js";
import { buildCsv } from "../csv.js";

export default class RowsCommand extends Command {
  static description = "Print dataset rows.";

  static args = {
    datasetId: Args.string({ required: true }),
  };

  static flags = {
    json: Flags.boolean({
      default: false,
      description: "print machine-readable JSON",
    }),
    csv: Flags.boolean({
      default: false,
      description: "print CSV",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RowsCommand);
    const [dataset, rows] = await Promise.all([
      getDataset(args.datasetId),
      getRows(args.datasetId),
    ]);

    if (flags.csv) {
      this.log(buildCsv(dataset, rows));
      return;
    }

    if (flags.json) {
      this.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    this.log(buildCsv(dataset, rows));
  }
}
