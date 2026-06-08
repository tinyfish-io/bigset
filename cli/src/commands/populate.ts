import { Args, Command, Flags } from "@oclif/core";
import { populateDataset, waitForDataset } from "../client.js";

export default class PopulateCommand extends Command {
  static description = "Start population for an existing dataset.";

  static args = {
    datasetId: Args.string({ required: true }),
  };

  static flags = {
    wait: Flags.boolean({
      default: false,
      description: "wait until the populate run finishes",
    }),
    json: Flags.boolean({
      default: false,
      description: "print machine-readable JSON",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PopulateCommand);
    const run = await populateDataset(args.datasetId);
    let status: string | undefined;
    let rowCount: number | undefined;

    if (flags.wait) {
      const dataset = await waitForDataset(args.datasetId, {
        intervalMs: 5000,
        timeoutMs: 20 * 60 * 1000,
        onPoll: flags.json
          ? undefined
          : (current) => {
              process.stderr.write(
                `Status: ${current.status}, rows: ${current.rowCount ?? 0}\n`,
              );
            },
      });
      status = dataset.status;
      rowCount = dataset.rowCount ?? 0;
      if (dataset.status === "failed") {
        throw new Error(dataset.lastStatusError ?? "Dataset population failed");
      }
    }

    if (flags.json) {
      this.log(JSON.stringify({ runId: run.runId, status, rowCount }, null, 2));
      return;
    }

    this.log(`Started populate run ${run.runId}`);
  }
}
