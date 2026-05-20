import type {
  DatasetRecipe,
  DatasetRecipeBenchmarkScore,
  DatasetRecipeRunResult,
} from "./recipe-types.js";

export interface DatasetRecipePromotionDecision {
  shouldPromote: boolean;
  reasons: string[];
  rejectionReasons: string[];
  activeProductionScore?: number;
  candidateProductionScore: number;
  activeBenchmarkScore?: number;
  candidateBenchmarkScore?: number;
}

export interface DatasetRecipePromotionResult {
  decision: DatasetRecipePromotionDecision;
  activeRecipe: DatasetRecipe;
  retiredRecipe?: DatasetRecipe;
}

export function decideRecipePromotion(input: {
  activeRun?: DatasetRecipeRunResult;
  candidateRun: DatasetRecipeRunResult;
}): DatasetRecipePromotionDecision {
  const candidateProductionScore = input.candidateRun.productionValidation.score;
  const activeProductionScore = input.activeRun?.productionValidation.score;
  const candidateBenchmarkScore = scoreValue(input.candidateRun.benchmarkScore);
  const activeBenchmarkScore = scoreValue(input.activeRun?.benchmarkScore);
  const reasons: string[] = [];
  const rejectionReasons: string[] = [];

  if (input.candidateRun.runStatus !== "succeeded") {
    rejectionReasons.push("Candidate run did not succeed.");
  }

  if (!input.candidateRun.productionValidation.isValid) {
    rejectionReasons.push(
      ...input.candidateRun.productionValidation.criticalIssues
    );
  }

  if (input.candidateRun.benchmarkScore?.passed === false) {
    rejectionReasons.push("Candidate benchmark score did not pass.");
  }

  if (activeProductionScore !== undefined) {
    if (candidateProductionScore < activeProductionScore) {
      rejectionReasons.push("Candidate production validation score regressed.");
    } else if (candidateProductionScore > activeProductionScore) {
      reasons.push("Candidate production validation score improved.");
    }
  } else {
    reasons.push("No active recipe run exists.");
  }

  if (
    activeBenchmarkScore !== undefined &&
    candidateBenchmarkScore !== undefined
  ) {
    if (candidateBenchmarkScore < activeBenchmarkScore) {
      rejectionReasons.push("Candidate benchmark score regressed.");
    } else if (candidateBenchmarkScore > activeBenchmarkScore) {
      reasons.push("Candidate benchmark score improved.");
    }
  }

  if (
    rejectionReasons.length === 0 &&
    reasons.length === 0 &&
    activeProductionScore !== undefined
  ) {
    rejectionReasons.push("Candidate did not improve validation or benchmark score.");
  }

  return {
    shouldPromote: rejectionReasons.length === 0,
    reasons,
    rejectionReasons,
    activeProductionScore,
    candidateProductionScore,
    activeBenchmarkScore,
    candidateBenchmarkScore,
  };
}

export function applyRecipePromotionDecision(input: {
  activeRecipe: DatasetRecipe;
  candidateRecipe: DatasetRecipe;
  activeRun?: DatasetRecipeRunResult;
  candidateRun: DatasetRecipeRunResult;
}): DatasetRecipePromotionResult {
  const decision = decideRecipePromotion({
    activeRun: input.activeRun,
    candidateRun: input.candidateRun,
  });

  if (!decision.shouldPromote) {
    return {
      decision,
      activeRecipe: input.activeRecipe,
    };
  }

  return {
    decision,
    activeRecipe: {
      ...input.candidateRecipe,
      status: "active",
      lastSuccessfulRunAt: input.candidateRun.completedAt,
      lastValidationScore: input.candidateRun.productionValidation.score,
    },
    retiredRecipe: {
      ...input.activeRecipe,
      status: "retired",
    },
  };
}

function scoreValue(score?: DatasetRecipeBenchmarkScore): number | undefined {
  return typeof score?.score === "number" && Number.isFinite(score.score)
    ? score.score
    : undefined;
}
