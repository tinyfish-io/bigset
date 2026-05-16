import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import type {
  DatasetBuildPlan,
  DatasetRunArtifact,
  DatasetSchema,
  DatasetUpdateCadence,
} from "./dataset-builder/types.js";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const dataset = pgTable(
  "dataset",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    userRequest: text("user_request").notNull(),
    updateCadence: text("update_cadence")
      .$type<DatasetUpdateCadence>()
      .notNull(),
    status: text("status")
      .$type<"draft" | "needs_input" | "ready" | "running" | "failed">()
      .notNull()
      .default("draft"),
    schema: jsonb("schema").$type<DatasetSchema>().notNull(),
    buildPlan: jsonb("build_plan").$type<DatasetBuildPlan>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("dataset_owner_user_id_idx").on(table.ownerUserId),
    index("dataset_status_idx").on(table.status),
  ]
);

export const datasetRun = pgTable(
  "dataset_run",
  {
    id: text("id").primaryKey(),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => dataset.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"queued" | "running" | "needs_input" | "succeeded" | "failed">()
      .notNull()
      .default("queued"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    artifact: jsonb("artifact").$type<DatasetRunArtifact>(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("dataset_run_dataset_id_idx").on(table.datasetId),
    index("dataset_run_status_idx").on(table.status),
  ]
);
