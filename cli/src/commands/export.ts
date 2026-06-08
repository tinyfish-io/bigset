import { Args, Command, Flags } from "@oclif/core";
import { writeFile } from "node:fs/promises";
import { getDataset, getRows } from "../client.js";
import { buildCsv } from "../csv.js";

export default class ExportCommand extends Command {
  static description = "Export dataset rows to a file.";

  static args = {
    datasetId: Args.string({ required: true }),
  };

  static flags = {
    csv: Flags.string({
      char: "o",
      required: true,
      description: "CSV output path",
    }),
    json: Flags.boolean({
      default: false,
      description: "print machine-readable JSON",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExportCommand);
    const [dataset, rows] = await Promise.all([
      getDataset(args.datasetId),
      getRows(args.datasetId),
    ]);

    await writeFile(flags.csv, buildCsv(dataset, rows), "utf8");

    if (flags.json) {
      this.log(
        JSON.stringify(
          { datasetId: dataset._id, rowCount: rows.length, csvPath: flags.csv },
          null,
          2,
        ),
      );
      return;
    }

    this.log(`Wrote ${rows.length} rows to ${flags.csv}`);
  }
}
