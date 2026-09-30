import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	EFFORT_DESCRIPTIONS,
	EFFORT_INSTRUCTIONS,
	EVIDENCE_CODE_POINTS,
	OMISSION_MARK,
	POLICY_VERSION,
	STANDARD_EFFORTS,
	TRANSPORT_BODY_BYTES,
	classifyApplication,
	decideEffort,
	decideSingleCandidate,
	effortCriteria,
	effortState,
	fallbackEffort,
	fitEvidenceToBudget,
	prepareEvidence,
	readAnswerConfidence,
	truncateEvidenceText,
	unifiedEffortCandidates,
	validateProbabilities,
} from "../src/index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FIVE = [...STANDARD_EFFORTS];

function probs(values: Record<string, number>) {
	return values;
}

test("policy version and descriptions are stable shared text", () => {
	assert.equal(POLICY_VERSION, "2026-09-30.2");
	assert.deepEqual(STANDARD_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(EFFORT_DESCRIPTIONS.low, "做法和要求明确，局部修改、阅读或验证，少量推理即可完成");
	assert.equal(EFFORT_DESCRIPTIONS.max, "最难的单个问题，广泛探索与正确性推理仍会改变结论；不因篇幅或重要性自动使用");
	assert.match(EFFORT_INSTRUCTIONS, /lowest sufficient/);
	assert.match(EFFORT_INSTRUCTIONS, /previous effort is only a fact/);
	assert.match(EFFORT_INSTRUCTIONS, /single tool error/);
	assert.doesNotMatch(EFFORT_INSTRUCTIONS, /Keep current effort unless there is a clear reason/);
	assert.equal(OMISSION_MARK, "\n[...omitted...]\n");
	assert.equal(TRANSPORT_BODY_BYTES, 28_000);
});

test("confidence boundaries and a raise from the top probability", () => {
	const candidates = FIVE;
	const distribution = probs({ low: 0.05, medium: 0.5, high: 0.3, xhigh: 0.1, max: 0.05 });
	const at = (confidence: number) => decideEffort({ candidates, rawChoice: "medium", rawConfidence: confidence, rawProbabilities: distribution });
	assert.equal(at(0.49).ok && at(0.49).decision.selectedEffort, "high");
	assert.equal(at(0.49).ok && at(0.49).decision.decisionReason, "raised");
	assert.equal(at(0.49).ok && at(0.49).decision.raised, true);
	assert.equal(at(0.5).ok && at(0.5).decision.selectedEffort, "medium");
	assert.equal(at(0.5).ok && at(0.5).decision.decisionReason, "confidence-kept");
	assert.equal(at(0.51).ok && at(0.51).decision.selectedEffort, "medium");
	assert.equal(at(0.51).ok && at(0.51).decision.decisionReason, "confidence-kept");
	const mediumTop = decideEffort({
		candidates,
		rawChoice: "low",
		rawConfidence: 0.4,
		rawProbabilities: probs({ low: 0.1, medium: 0.6, high: 0.2, xhigh: 0.05, max: 0.05 }),
	});
	assert.equal(mediumTop.ok && mediumTop.decision.selectedEffort, "high");
	assert.equal(mediumTop.ok && mediumTop.decision.decisionReason, "raised");
	assert.equal(mediumTop.ok && mediumTop.decision.choiceTopMismatch, true);
	assert.equal(mediumTop.ok && mediumTop.decision.rawConfidence, 0.4);
	assert.notEqual(mediumTop.ok && mediumTop.decision.rawConfidence, mediumTop.ok && mediumTop.decision.topProbability);
});

test("ties raise from the higher tied effort and the top effort is capped", () => {
	const tied = decideEffort({
		candidates: FIVE,
		rawChoice: "medium",
		rawConfidence: 0.2,
		rawProbabilities: probs({ low: 0.1, medium: 0.4, high: 0.4, xhigh: 0.05, max: 0.05 }),
	});
	assert.equal(tied.ok && tied.decision.tied, true);
	assert.equal(tied.ok && tied.decision.topEffort, "high");
	assert.ok(tied.ok && tied.decision.margin !== null && Math.abs(tied.decision.margin - 0.3) < 1e-12);
	assert.equal(tied.ok && tied.decision.selectedEffort, "xhigh");
	assert.equal(tied.ok && tied.decision.decisionReason, "raised-tie");
	const capped = decideEffort({
		candidates: FIVE,
		rawChoice: "high",
		rawConfidence: 0.1,
		rawProbabilities: probs({ low: 0, medium: 0, high: 0, xhigh: 0.2, max: 0.8 }),
	});
	assert.equal(capped.ok && capped.decision.selectedEffort, "max");
	assert.equal(capped.ok && capped.decision.decisionReason, "capped");
	assert.equal(capped.ok && capped.decision.capped, true);
	assert.equal(capped.ok && capped.decision.raised, false);
	const nearTie = decideEffort({
		candidates: ["low", "high"],
		rawChoice: "low",
		rawConfidence: 0.1,
		rawProbabilities: { low: 0.5, high: 0.5 + Number.EPSILON },
	});
	assert.equal(nearTie.ok && nearTie.decision.tied, false);
	assert.equal(nearTie.ok && nearTie.decision.topEffort, "high");
});

test("sparse candidates use the next offered level, not a missing name", () => {
	const sparse = decideEffort({
		candidates: ["medium", "xhigh"],
		rawChoice: "medium",
		rawConfidence: 0.3,
		rawProbabilities: { medium: 0.7, xhigh: 0.3 },
	});
	assert.equal(sparse.ok && sparse.decision.selectedEffort, "xhigh");
	assert.equal(sparse.ok && sparse.decision.decisionReason, "raised");
	assert.equal(sparse.ok && sparse.decision.rawProbabilities.low, null);
	assert.equal(sparse.ok && sparse.decision.rawProbabilities.high, null);
	assert.equal(sparse.ok && sparse.decision.rawProbabilities.medium, 0.7);
});

test("missing or invalid confidence and probabilities do not raise or invent a distribution", () => {
	const missing = decideEffort({ candidates: FIVE, rawChoice: "low", rawConfidence: undefined, rawProbabilities: undefined });
	assert.equal(missing.ok && missing.decision.selectedEffort, "low");
	assert.equal(missing.ok && missing.decision.decisionReason, "skipped-confidence");
	assert.equal(missing.ok && missing.decision.confidenceStatus, "missing");
	assert.equal(missing.ok && missing.decision.rawConfidence, null);
	const invalidConfidence = decideEffort({
		candidates: ["low", "high"],
		rawChoice: "low",
		rawConfidence: "0.1",
		rawProbabilities: { low: 0.2, high: 0.8 },
	});
	assert.equal(invalidConfidence.ok && invalidConfidence.decision.selectedEffort, "low");
	assert.equal(invalidConfidence.ok && invalidConfidence.decision.decisionReason, "skipped-confidence");
	assert.equal(invalidConfidence.ok && invalidConfidence.decision.rawConfidence, null);
	const badProbability = decideEffort({
		candidates: ["low", "high"],
		rawChoice: "low",
		rawConfidence: 0.2,
		rawProbabilities: { low: 0.2, high: 0.2 },
	});
	assert.equal(badProbability.ok && badProbability.decision.selectedEffort, "low");
	assert.equal(badProbability.ok && badProbability.decision.decisionReason, "skipped-probability");
	assert.equal(badProbability.ok && badProbability.decision.probabilityStatus, "invalid");
	assert.equal(badProbability.ok && badProbability.decision.rawProbabilities.low, null);
	const keptDespiteTop = decideEffort({
		candidates: ["low", "high"],
		rawChoice: "low",
		rawConfidence: 0.8,
		rawProbabilities: { low: 0.1, high: 0.9 },
	});
	assert.equal(keptDespiteTop.ok && keptDespiteTop.decision.selectedEffort, "low");
	assert.equal(keptDespiteTop.ok && keptDespiteTop.decision.choiceTopMismatch, true);
	assert.equal(decideEffort({ candidates: ["low"], rawChoice: "high", rawConfidence: 0.1, rawProbabilities: { low: 1 } }).ok, false);
});

test("declared and default probability rounding", () => {
	const keys = ["low", "high"];
	assert.equal(validateProbabilities({ low: 0.6, high: 0.39 }, keys).status, "available");
	assert.equal(validateProbabilities({ low: 0.6, high: 0.39 }, keys, 4).status, "invalid");
	assert.equal(validateProbabilities({ low: 0.6, high: 0.4 }, keys, 4).status, "available");
	assert.equal(validateProbabilities({ low: 0, high: 0 }, keys, 0).status, "invalid");
	assert.equal(validateProbabilities({ low: 0.2, high: 0.8 }, keys, -1).status, "invalid");
	assert.equal(validateProbabilities({ low: 0.2, high: 0.8 }, keys, 1.5).status, "invalid");
	assert.equal(validateProbabilities(undefined, keys).status, "missing");
});

test("single candidate and fallback order stay inside the legal set", () => {
	const single = decideSingleCandidate(["high"], "low");
	assert.equal(single.selectedEffort, "high");
	assert.equal(single.decisionReason, "single-candidate");
	const supported = ["low", "medium", "high"];
	const current = fallbackEffort({ candidates: ["medium", "high"], currentEffort: "high", defaultEffort: "low", supportedInAdapterOrder: supported, floor: "medium", failureClass: "transport" });
	assert.equal(current.selectedEffort, "high");
	assert.equal(current.decisionReason, "fallback-previous");
	assert.equal(current.fallbackSource, "previous");
	const adapterDefault = fallbackEffort({ candidates: ["low", "medium", "high"], currentEffort: null, defaultEffort: "medium", supportedInAdapterOrder: supported, failureClass: "transport" });
	assert.equal(adapterDefault.selectedEffort, "medium");
	assert.equal(adapterDefault.decisionReason, "fallback-default");
	const floor = fallbackEffort({ candidates: ["medium", "high"], currentEffort: "low", defaultEffort: "low", supportedInAdapterOrder: supported, floor: "medium", failureClass: "unavailable" });
	assert.equal(floor.selectedEffort, "medium");
	assert.equal(floor.decisionReason, "fallback-floor");
	const lowest = fallbackEffort({ candidates: ["medium", "high"], currentEffort: null, defaultEffort: "max", supportedInAdapterOrder: supported, floor: "medium", failureClass: "invalid-choice" });
	assert.equal(lowest.selectedEffort, "medium");
	assert.equal(lowest.decisionReason, "fallback-lowest");
	assert.throws(() => fallbackEffort({ candidates: [], failureClass: "transport" }), /candidates/);
});

test("floors allow low, reject unsupported or empty standard ranges, and do not sort unknown levels", () => {
	assert.deepEqual(unifiedEffortCandidates("openai/gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]).candidates, FIVE);
	assert.deepEqual(unifiedEffortCandidates("gpt-6.1-sol", ["low", "medium", "high"], "low").candidates, ["low", "medium", "high"]);
	assert.equal(unifiedEffortCandidates("gpt-6.1-sol", ["low", "medium", "high"], "xhigh").code, "floor-unsupported");
	assert.equal(unifiedEffortCandidates("gpt-6.1-sol", ["off", "minimal"], "off").code, "no-candidates-above-floor");
	assert.equal(unifiedEffortCandidates("gpt-6.1-sol", []).code, "empty-candidates");
	assert.equal(unifiedEffortCandidates("gpt-6.1-sol", ["high", "low", "medium"]).code, "unordered");
	assert.equal(unifiedEffortCandidates("gpt-6.1-sol", ["off", "minimal"]).unified, false);
	assert.equal(unifiedEffortCandidates("openai/gpt-6-sol", ["low", "medium"]).unified, false);
	assert.equal(unifiedEffortCandidates("gpt-6-luna", ["off", "low", "medium"], "off").candidates?.join(), "low,medium");
	assert.equal(unifiedEffortCandidates("other", ["low", "high"]).unified, false);
});

test("evidence keeps code-point halves and the latest user text inside eight events", () => {
	const marker = Array.from(OMISSION_MARK).length;
	const available = EVIDENCE_CODE_POINTS - marker;
	const long = "头".repeat(2000) + "尾".repeat(2000);
	const truncated = truncateEvidenceText(long);
	const chars = Array.from(truncated.text);
	assert.equal(chars.length, EVIDENCE_CODE_POINTS);
	assert.equal(chars.slice(0, Math.ceil(available / 2)).join(""), "头".repeat(Math.ceil(available / 2)));
	assert.ok(truncated.text.includes(OMISSION_MARK));
	assert.equal(chars.slice(chars.length - (available - Math.ceil(available / 2))).join(""), "尾".repeat(available - Math.ceil(available / 2)));
	const events = [
		{ role: "user" as const, text: "latest ask" },
		...Array.from({ length: 9 }, (_, index) => ({ role: "tool" as const, text: `tool ${index}` })),
	];
	const prepared = prepareEvidence(events);
	assert.equal(prepared.messages.length, 8);
	assert.equal(prepared.replacedOldest, true);
	assert.equal(prepared.messages[0]?.text, "latest ask");
	assert.equal(prepared.messages[0]?.role, "user");
	assert.equal(prepared.messages[1]?.text, "tool 2");
	assert.equal(prepareEvidence([{ role: "user", text: "  " }, { role: "assistant", text: "kept" }]).messages.length, 1);
});

test("transport budget drops oldest evidence and then fails closed", () => {
	const messages = [
		{ role: "user", text: "old" },
		{ role: "assistant", text: "mid" },
		{ role: "user", text: "new" },
	];
	const dropped = fitEvidenceToBudget(messages, (items) => items.length <= 2);
	assert.deepEqual(dropped.messages.map((item) => item.text), ["mid", "new"]);
	assert.equal(dropped.overflow, false);
	const overflow = fitEvidenceToBudget(messages, () => false);
	assert.equal(overflow.overflow, true);
	assert.deepEqual(overflow.messages.map((item) => item.text), ["new"]);
	const body = (items: readonly { text: string }[]) => Buffer.byteLength(JSON.stringify({
		model: "typesafe-ai/jev",
		state: effortState("openai/gpt-6.1-sol", "high", items.map((item) => ({ role: "user" as const, text: item.text }))),
		questions: { effort: { type: "choice", instructions: EFFORT_INSTRUCTIONS, criteria: effortCriteria(FIVE) } },
	}), "utf8");
	const wide = Array.from({ length: 8 }, (_, index) => ({ role: "user", text: "测".repeat(1600) + index }));
	const fitted = fitEvidenceToBudget(wide, (items) => body(items) <= TRANSPORT_BODY_BYTES);
	assert.equal(fitted.overflow, false);
	assert.ok(body(fitted.messages) <= TRANSPORT_BODY_BYTES);
	assert.ok(fitted.dropped > 0);
});

test("application separates selected effort from the confirmed effective effort", () => {
	const applied = classifyApplication({ selectedEffort: "high", candidates: FIVE, confirmedEffective: "high", requestEffort: "low", protocolBlocked: false, cancelled: false });
	assert.equal(applied.applyStatus, "applied");
	assert.equal(applied.effectiveEffort, "high");
	assert.equal(applied.requestEffort, "low");
	const blocked = classifyApplication({ selectedEffort: "xhigh", candidates: FIVE, confirmedEffective: "high", requestEffort: "low", protocolBlocked: true, cancelled: false });
	assert.equal(blocked.applyStatus, "not-applied");
	assert.equal(blocked.nextCurrentEffort, "high");
	assert.notEqual(blocked.nextCurrentEffort, "xhigh");
	const illegal = classifyApplication({ selectedEffort: "high", candidates: ["medium", "high", "xhigh"], confirmedEffective: "low", requestEffort: "low", protocolBlocked: true, cancelled: false });
	assert.equal(illegal.applyStatus, "apply-failed");
	assert.equal(illegal.nextCurrentEffort, null);
	const unknown = classifyApplication({ selectedEffort: "high", candidates: FIVE, confirmedEffective: null, requestEffort: null, protocolBlocked: true, cancelled: false });
	assert.equal(unknown.applyStatus, "apply-failed");
	const cancelled = classifyApplication({ selectedEffort: "high", candidates: FIVE, confirmedEffective: "high", requestEffort: "high", protocolBlocked: false, cancelled: true });
	assert.equal(cancelled.applyStatus, "cancelled");
	assert.equal(cancelled.nextCurrentEffort, null);
});

test("fixtures keep answer confidence distinct from the top probability", () => {
	const success = JSON.parse(readFileSync(join(root, "fixtures/pi-success.json"), "utf8")) as { body: unknown };
	const recovery = JSON.parse(readFileSync(join(root, "fixtures/pi-recovery.json"), "utf8")) as { body: unknown };
	const dsh = JSON.parse(readFileSync(join(root, "fixtures/dsh-success.json"), "utf8")) as { body: unknown };
	assert.equal(readAnswerConfidence(success.body, "effort"), 0.42);
	assert.notEqual(readAnswerConfidence(success.body, "effort"), 0.7);
	assert.equal(readAnswerConfidence(recovery.body, "effort"), 0.3);
	assert.equal(readAnswerConfidence(dsh.body, "route"), 0.42);
	const decision = decideEffort({
		candidates: ["low", "medium", "high"],
		rawChoice: "medium",
		rawConfidence: readAnswerConfidence(success.body, "effort"),
		rawProbabilities: { low: 0.1, medium: 0.2, high: 0.7 },
	});
	assert.equal(decision.ok && decision.decision.selectedEffort, "high");
	assert.equal(decision.ok && decision.decision.decisionReason, "capped");
	const same = decideEffort({
		candidates: ["low", "medium", "high"],
		rawChoice: "medium",
		rawConfidence: readAnswerConfidence(dsh.body, "route"),
		rawProbabilities: { low: 0.1, medium: 0.2, high: 0.7 },
	});
	assert.equal(same.ok && same.decision.selectedEffort, decision.ok && decision.decision.selectedEffort);
	assert.equal(same.ok && same.decision.decisionReason, decision.ok && decision.decision.decisionReason);
});
