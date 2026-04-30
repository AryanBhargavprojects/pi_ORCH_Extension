export type PlanPhase =
	| "clarifying"
	| "researching-codebase"
	| "researching-docs"
	| "assessing-feasibility"
	| "synthesizing"
	| "completed"
	| "cancelled"
	| "failed";

export type PlanClarificationResult = {
	refinedGoal: string;
	needsClarification: boolean;
	questions: string[];
	assumptions: string[];
};

export type PlanStateFile = {
	id: string;
	goal: string;
	refinedGoal: string | null;
	phase: PlanPhase;
	stateDir: string;
	startedAt: string;
	completedAt: string | null;
};

export type PlanResult = {
	id: string;
	goal: string;
	refinedGoal: string;
	feasibility: string;
	planPath: string;
	suggestedNextStep: string;
};
