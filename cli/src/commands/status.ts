import { Args, Command, Flags } from "@oclif/core";
import { getDataset } from "../client.js";

export default class StatusCommand extends Command {
  static description = "Show one dataset's status.";

  static args = {
    datasetId: Args.string({ required: true }),
  };

  static flags = {
    json: Flags.boolean({
      default: false,
      description: "print machine-readable JSON",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StatusCommand);
    const dataset = await getDataset(args.datasetId);

    if (flags.json) {
      this.log(JSON.stringify({ dataset }, null, 2));
      return;
    }

    this.log(`id: ${dataset._id}`);
    this.log(`name: ${dataset.name}`);
    this.log(`status: ${dataset.status}`);
    this.log(`rows: ${dataset.rowCount ?? 0}`);
    if (dataset.lastStatusError) this.log(`error: ${dataset.lastStatusError}`);
  }
}
