import { Args, Command, Flags } from "@oclif/core";
import { writeFile } from "node:fs/promises";
import {
  createDataset,
  getRows,
  type InferredSchema,
  populateDataset,
  waitForDataset,
} from "../client.js";
import { buildCsv } from "../csv.js";

function formatPrimaryKey(primaryKey: InferredSchema["primary_key"]): string {
  return Array.isArray(primaryKey) ? primaryKey.join(", ") : primaryKey;
}

function labelValue(label: string, value: string | number): string {
  return `  ${label.padEnd(12)} ${value}\n`;
}

function truncate(text: string, max = 110): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function printSchema(schema: InferredSchema): void {
  const nameWidth = Math.max(18, ...schema.columns.map((column) => column.name.length));
  process.stdout.write("\n[schema]\n");
  process.stdout.write(labelValue("name", schema.dataset_name));
  process.stdout.write(labelValue("primary key", formatPrimaryKey(schema.primary_key)));
  process.stdout.write(labelValue("retrieval", schema.retrieval_strategy));
  process.stdout.write(labelValue("source", truncate(schema.source_hint)));
  process.stdout.write("\n[columns]\n");
  for (const column of schema.columns) {
    const tags = [
      column.type,
      column.is_primary_key ? "pk" : null,
      column.nullable ? "nullable" : null,
    ].filter(Boolean).join(", ");
    process.stdout.write(
      `  ${column.name.padEnd(nameWidth)}  ${tags.padEnd(20)} ${truncate(column.retrieval_hint)}\n`,
    );
  }
  process.stdout.write("\n");
}

export default class CreateCommand extends Command {
  static description = "Infer a schema, create a dataset, and optionally populate it.";

  static args = {
    prompt: Args.string({ required: true }),
  };

  static flags = {
    rows: Flags.integer({
      char: "r",
      default: 100,
      description: "maximum rows to collect",
    }),
    cadence: Flags.string({
      default: "manual",
      description: "refresh cadence",
      options: ["manual", "30m", "6h", "12h", "daily", "weekly"],
    }),
    wait: Flags.boolean({
      default: false,
      description: "wait until the populate run finishes",
    }),
    csv: Flags.string({
      description: "write final rows to a CSV file; implies --wait",
    }),
    "skip-populate": Flags.boolean({
      default: false,
      description: "create the dataset but do not start population",
    }),
    json: Flags.boolean({
      default: false,
      description: "print machine-readable JSON",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CreateCommand);
    const shouldWait = flags.wait || Boolean(flags.csv);

    const created = await createDataset({
      prompt: args.prompt,
      maxRowCount: flags.rows,
      refreshCadence: flags.cadence,
    });

    let runId: string | undefined;
    let dataset = created.dataset;

    if (!flags.json) {
      printSchema(created.schema);
      process.stdout.write("[dataset]\n");
      process.stdout.write(labelValue("id", dataset._id));
      process.stdout.write(labelValue("name", dataset.name));
      process.stdout.write(labelValue("rows", dataset.maxRowCount ?? flags.rows));
      process.stdout.write(labelValue("cadence", flags.cadence));
    }

    if (!flags["skip-populate"]) {
      const run = await populateDataset(dataset._id);
      runId = run.runId;
      if (!flags.json) {
        process.stdout.write("\n[run]\n");
        process.stdout.write(labelValue("id", run.runId));
        process.stdout.write(labelValue("status", "started"));
      }
    }

    if (shouldWait && !flags["skip-populate"]) {
      dataset = await waitForDataset(dataset._id, {
        intervalMs: 5000,
        timeoutMs: 20 * 60 * 1000,
        onPoll: flags.json
          ? undefined
          : (current) => {
              process.stdout.write(
                `  ${new Date().toLocaleTimeString()}  ${current.status.padEnd(9)} rows=${current.rowCount ?? 0}\n`,
              );
            },
      });

      if (dataset.status === "failed") {
        throw new Error(dataset.lastStatusError ?? "Dataset population failed");
      }
    }

    let csvPath: string | undefined;
    if (flags.csv) {
      const rows = await getRows(dataset._id);
      await writeFile(flags.csv, buildCsv(dataset, rows), "utf8");
      csvPath = flags.csv;
      if (!flags.json) {
        process.stdout.write("\n[export]\n");
        process.stdout.write(labelValue("file", flags.csv));
        process.stdout.write(labelValue("rows", rows.length));
      }
    }

    const output = {
      datasetId: dataset._id,
      name: dataset.name,
      status: dataset.status,
      rowCount: dataset.rowCount ?? 0,
      runId,
      csvPath,
    };

    if (flags.json) {
      this.log(JSON.stringify(output, null, 2));
      return;
    }

    this.log(`\n[done]\n${labelValue("dataset", output.datasetId).trimEnd()}`);
    this.log(labelValue("status", output.status).trimEnd());
    this.log(labelValue("rows", output.rowCount).trimEnd());
  }
}
