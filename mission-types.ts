import type { OrchRoleName } from "./config.js";

export type ValidationCriterionType = "behavior" | "test" | "file" | "review";
export type ValidationIssueSeverity = "critical" | "major" | "minor";
export type MissionStatus = "completed" | "needs-attention" | "failed";
export type MissionFeatureStateStatus = "pending" | "in-progress" | "done" | "failed";
export type MissionSharedFeatureKind = "planned" | "fix";

export type DelegationEventKind =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; label: string; detail: string };

export type DelegationStatus = "running" | "done" | "failed" | "aborted";

export type DelegationBuffer = {
	role: OrchRoleName;
	featureId: string;
	status: DelegationStatus;
	startedAt: number;
	elapsedMs: number;
	edits: number;
	bashes: number;
	reads: number;
	otherTools: number;
	events: DelegationEventKind[];
	spinnerIdx: number;
	verbIdx: number;
	finalSummary: string;
	finalHandoff: string;
	finalIssues: Array<{ severity: string; title: string; details: string }>;
	finalWarnings: Array<{ title: string; details: string }>;
	issueCount: number;
};

export type MissionFeature = {
	id: string;
	title: string;
	goal: string;
	deliverables: string[];
	dependencies: string[];
	notes: string[];
};

export type MissionMilestone = {
	id: string;
	title: string;
	summary: string;
	featureIds: string[];
	validationTrigger: string;
	notes: string[];
};

export type ValidationCriterion = {
	id: string;
	title: string;
	description: string;
	type: ValidationCriterionType;
};

export type ValidationContract = {
	summary: string;
	criteria: ValidationCriterion[];
};

export type MissionPlan = {
	missionTitle: string;
	summary: string;
	guidelines: string[];
	features: MissionFeature[];
	milestones: MissionMilestone[];
	validationContract: ValidationContract;
	notes: string[];
	rawOutput: string;
};

export type WorkerRun = {
	summary: string;
	changes: string[];
	testsRun: string[];
	notes: string[];
	followUps: string[];
	handoff: string;
	rawOutput: string;
	provider: string;
	modelId: string;
};

export type ValidationIssue = {
	severity: ValidationIssueSeverity;
	title: string;
	details: string;
	action: string;
};

export type ValidationResult = {
	passed: boolean;
	summary: string;
	issues: ValidationIssue[];
	evidence: string[];
	rawOutput: string;
	provider: string;
	modelId: string;
};

export type MissionFixTask = {
	id: string;
	title: string;
	instructions: string[];
	deliverables: string[];
	notes: string[];
};

export type SteeringResult = {
	summary: string;
	instructions: string[];
	fixTasks: MissionFixTask[];
	guidelineUpdates: string[];
	rawOutput: string;
	provider: string;
	modelId: string;
};

export type FeatureAttemptRecord = {
	attempt: number;
	worker: WorkerRun;
	validation: ValidationResult;
	steering?: SteeringResult;
};

export type FeatureRunRecord = {
	feature: MissionFeature;
	status: "passed" | "failed";
	attempts: FeatureAttemptRecord[];
};

export type MilestoneRunRecord = {
	milestone: MissionMilestone;
	status: "passed" | "failed";
	validation: ValidationResult;
};

export type MissionStatePaths = {
	missionDir: string;
	planFile: string;
	featuresFile: string;
	validationContractFile: string;
	knowledgeBaseFile: string;
	guidelinesFile: string;
	stateFile: string;
};

export type MissionStateHandle = {
	missionId: string;
	goal: string;
	startedAt: string;
	paths: MissionStatePaths;
};

export type MissionFeatureStateEntry = {
	id: string;
	title: string;
	status: MissionFeatureStateStatus;
	attempts: number;
	milestoneId: string;
	kind: MissionSharedFeatureKind;
	sourceFeatureId?: string;
	workerSummary: string | null;
	validatorVerdict: "passed" | "failed" | null;
	lastUpdatedAt: string;
};

export type MissionMilestoneStateEntry = {
	id: string;
	title: string;
	summary: string;
	featureIds: string[];
	validationTrigger: string;
	notes: string[];
	status: MissionFeatureStateStatus;
	validationSummary: string | null;
	lastUpdatedAt: string;
	lastValidatedAt: string | null;
};

export type MissionFeaturesStateFile = {
	features: MissionFeatureStateEntry[];
	milestones: MissionMilestoneStateEntry[];
};

export type MissionLiveState = {
	missionId: string;
	phase: string;
	currentFeatureIndex: number | null;
	currentFeatureId: string | null;
	currentAttempt: number | null;
	currentMilestoneId: string | null;
	totalFeatures: number;
	completedFeatures: number;
	failedFeatures: number;
	totalMilestones: number;
	completedMilestones: number;
	failedMilestones: number;
	startedAt: string;
	lastUpdatedAt: string;
};

export type MissionPromptSharedState = {
	missionDir: string;
	planFile: string;
	featuresFile: string;
	validationContractFile: string;
	knowledgeBaseFile: string;
	guidelinesFile: string;
	stateFile: string;
	missionStateSummary: string;
	featureStatusSummary: string;
	currentMilestoneSummary: string;
	validationContractExcerpt: string;
	knowledgeBaseExcerpt: string;
	guidelinesExcerpt: string;
};

export type MissionRecord = {
	id: string;
	goal: string;
	status: MissionStatus;
	startedAt: string;
	completedAt: string;
	stateDir: string;
	plan: MissionPlan;
	featureRuns: FeatureRunRecord[];
	milestoneRuns: MilestoneRunRecord[];
	finalValidation?: ValidationResult;
	models: {
		orchestrator: string;
		worker: string;
		validator: string;
	};
};

export type MissionRunResult = {
	record: MissionRecord;
	filePath: string;
};
