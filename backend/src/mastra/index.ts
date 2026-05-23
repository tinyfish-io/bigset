import { Mastra } from '@mastra/core/mastra'
import { PostgresStore } from '@mastra/pg'
import {
  Observability,
  MastraStorageExporter,
  SensitiveDataFilter,
} from '@mastra/observability'
import { inferSchemaWorkflow } from "./workflows/infer-schema.js"
import { populateWorkflow } from "./workflows/populate.js"
import { populateAgent } from "./agents/populate.js"

const storage = new PostgresStore({
  id: 'mastra-pg-storage',
  connectionString: process.env.MASTRA_DATABASE_URL!,
})

export const mastra = new Mastra({
  agents: { populateAgent },
  workflows: { inferSchemaWorkflow, populateWorkflow },
  storage,
  observability: new Observability({
    
    configs: {
      default: {
        serviceName: 'bigset',
        exporters: [new MastraStorageExporter({ strategy: 'auto' })],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
})
