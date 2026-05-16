import { config } from "dotenv";

import { createTinyFishAgentGoal, createTinyFishAgentOutputSchema } from "./agent-harness.js";
import { createOpenRouterPlannerClient } from "./openrouter.js";
import { createDatasetBuildPlan } from "./planner.js";

config({ path: ".env.local" });
config({ path: "../.env.local" });
config();

const args = process.argv.slice(2);
const shouldUseOpenRouter = args.includes("--use-openrouter");
const userRequest = args.filter((arg) => arg !== "--use-openrouter").join(" ").trim();

if (!userRequest) {
  throw new Error(
    "Usage: npm run builder:plan -- \"latest blog posts from my competitors\" [--use-openrouter]"
  );
}

const plan = await createDatasetBuildPlan(
  {
    userRequest,
    planningMode: shouldUseOpenRouter ? "openrouter" : "deterministic",
  },
  {
    openRouterClient: shouldUseOpenRouter
      ? createOpenRouterPlannerClient({
          apiKey: process.env.OPENROUTER_API_KEY,
          model: process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini",
        })
      : undefined,
  }
);

console.log(
  JSON.stringify(
    {
      plan,
      tinyFishAgentGoal: createTinyFishAgentGoal(plan),
      tinyFishAgentOutputSchema: createTinyFishAgentOutputSchema(plan),
    },
    null,
    2
  )
);
