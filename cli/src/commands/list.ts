import { Command, Flags } from "@oclif/core";
import { listDatasets } from "../client.js";

export default class ListCommand extends Command {
  static description = "List local CLI-scoped datasets.";

  static flags = {
    json: Flags.boolean({
      default: false,
      description: "print machine-readable JSON",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ListCommand);
    const { datasets } = await listDatasets();

    if (flags.json) {
      this.log(JSON.stringify({ datasets }, null, 2));
      return;
    }

    for (const dataset of datasets) {
      this.log(
        `${dataset._id}\t${dataset.status}\t${dataset.rowCount ?? 0}\t${dataset.name}`,
      );
    }
  }
}
