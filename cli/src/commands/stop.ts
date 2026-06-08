import { Args, Command, Flags } from "@oclif/core";
import { stopDataset } from "../client.js";

export default class StopCommand extends Command {
  static description = "Stop a running dataset population.";

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
    const { args, flags } = await this.parse(StopCommand);
    const result = await stopDataset(args.datasetId);

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2));
      return;
    }

    this.log("Stop requested");
  }
}
