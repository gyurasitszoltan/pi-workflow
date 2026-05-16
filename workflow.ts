/**
 * Workflow Extension
 *
 * A task-driven discipline extension for pi agents.
 *
 * Gate principle: The agent may only use non-workflow tools if an active list
 * exists, has at least one non-closed task, and exactly one task is inprogress.
 *
 * Statuses: idle → inprogress → done (terminal)
 *           idle/inprogress → blocked ⇄ idle
 *           idle/inprogress/blocked → skipped (terminal)
 *
 * UI surfaces: status line, current-task widget, footer, /workflow overlay.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ──────────────────────────────────────────────────────────────────────

type WorkflowTaskStatus = "idle" | "inprogress" | "blocked" | "skipped" | "done";
type WorkflowTaskImportance = "low" | "normal" | "high" | "critical";

type WorkflowTaskUsage = {
	inputTokens: number;
	outputTokens: number;
	toolCalls: Record<string, number>;
};

type WorkflowTask = {
	id: number;
	text: string;
	status: WorkflowTaskStatus;
	importance: WorkflowTaskImportance;
	acceptance?: string[];
	blockedReason?: string;
	skippedReason?: string;
	doneNote?: string;
	evidence?: string[];
	createdAt: number;
	startedAt?: number;
	updatedAt?: number;
	completedAt?: number;
	elapsedMs: number;
	usage: WorkflowTaskUsage;
};

type WorkflowSnapshot = {
	tasks: WorkflowTask[];
	nextId: number;
	listTitle?: string;
	listDescription?: string;
	nudgedThisCycle: boolean;
	nudgeCounts: Record<number, number>;
	toolCounts: Record<string, number>;
	stateVersion: number;
	finalSummaryEmittedForVersion?: number;
};

type WorkflowDetails = {
	action: string;
	snapshot: WorkflowSnapshot;
	error?: string;
};

// ── Schema ─────────────────────────────────────────────────────────────────────

const WorkflowParams = Type.Object({
	action: StringEnum(
		["new-list", "list", "add", "start", "done", "pause", "block", "unblock", "skip", "remove", "update", "move", "clear"] as const,
		{ description: "Workflow action to perform" },
	),
	text: Type.Optional(Type.String({ description: "Task text (for add/update), or list title (for new-list)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Multiple task texts (for batch add). Use this to add several tasks at once." })),
	description: Type.Optional(Type.String({ description: "List description (for new-list)" })),
	id: Type.Optional(Type.Number({ description: "Task ID (for start/done/pause/block/unblock/skip/remove/update/move)" })),
	importance: Type.Optional(StringEnum(["low", "normal", "high", "critical"] as const, { description: "Task importance level (default: normal)" })),
	acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria for the task" })),
	reason: Type.Optional(Type.String({ description: "Reason for blocking or skipping a task (required for block/skip)" })),
	note: Type.Optional(Type.String({ description: "Completion note (for done)" })),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence of completion (for done)" })),
	beforeId: Type.Optional(Type.Number({ description: "Insert before this task ID (for move)" })),
	afterId: Type.Optional(Type.Number({ description: "Insert after this task ID (for move)" })),
	position: Type.Optional(Type.Number({ description: "1-indexed target position (for move)" })),
});

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<WorkflowTaskStatus, string> = {
	idle: "○",
	inprogress: "●",
	blocked: "■",
	skipped: "↷",
	done: "✓",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function isClosedStatus(status: WorkflowTaskStatus): boolean {
	return status === "done" || status === "skipped";
}

function flushElapsed(task: WorkflowTask): void {
	if (task.startedAt !== undefined) {
		task.elapsedMs += Date.now() - task.startedAt;
		task.startedAt = undefined;
	}
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatElapsedLive(task: WorkflowTask): string {
	let total = task.elapsedMs;
	if (task.startedAt !== undefined) total += Date.now() - task.startedAt;
	return formatElapsed(total);
}

function progressBar(percent: number, width = 10): string {
	const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtTok(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function cloneTask(task: WorkflowTask): WorkflowTask {
	return {
		...task,
		acceptance: task.acceptance ? [...task.acceptance] : undefined,
		evidence: task.evidence ? [...task.evidence] : undefined,
		usage: {
			inputTokens: task.usage.inputTokens,
			outputTokens: task.usage.outputTokens,
			toolCalls: { ...task.usage.toolCalls },
		},
	};
}

// ── Overlay component ──────────────────────────────────────────────────────────

class WorkflowListComponent {
	private theme: Theme;
	private onClose: () => void;
	private getTasks: () => WorkflowTask[];
	private getTitle: () => string | undefined;
	private getDesc: () => string | undefined;
	private getVersion: () => number;
	private cachedWidth?: number;
	private cachedVersion?: number;
	private cachedLines?: string[];

	constructor(
		getTasks: () => WorkflowTask[],
		getTitle: () => string | undefined,
		getDesc: () => string | undefined,
		theme: Theme,
		onClose: () => void,
		getVersion: () => number,
	) {
		this.getTasks = getTasks;
		this.getTitle = getTitle;
		this.getDesc = getDesc;
		this.theme = theme;
		this.onClose = onClose;
		this.getVersion = getVersion;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const version = this.getVersion();
		if (this.cachedLines && this.cachedWidth === width && this.cachedVersion === version) {
			return this.cachedLines;
		}

		const tasks = this.getTasks();
		const title = this.getTitle();
		const desc = this.getDesc();
		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const headingText = title || "Workflow";
		const heading = th.fg("accent", ` ${headingText} `);
		const headingLen = headingText.length + 2;
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) + heading + th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - headingLen))),
				width,
			),
		);

		if (desc) {
			lines.push(truncateToWidth(`  ${th.fg("muted", desc)}`, width));
		}
		lines.push("");

		if (tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Use workflow add to add tasks.")}`, width));
		} else {
			const done = tasks.filter((t) => t.status === "done").length;
			const skipped = tasks.filter((t) => t.status === "skipped").length;
			const blocked = tasks.filter((t) => t.status === "blocked").length;
			const active = tasks.filter((t) => t.status === "inprogress").length;
			const idle = tasks.filter((t) => t.status === "idle").length;
			const total = tasks.length;
			const closed = done + skipped;
			const pct = total > 0 ? Math.round((closed / total) * 100) : 0;

			lines.push(
				truncateToWidth(
					`  Progress: ${th.fg("accent", `${pct}%`)} ${th.fg("dim", `[${progressBar(pct)}]`)}`,
					width,
				),
			);
			lines.push(
				truncateToWidth(
					`  ${th.fg("success", `Done: ${done}`)} · ${th.fg("accent", `Active: ${active}`)} · ${th.fg("muted", `Idle: ${idle}`)} · ${th.fg("error", `Blocked: ${blocked}`)} · ${th.fg("dim", `Skipped: ${skipped}`)}`,
					width,
				),
			);
			lines.push("");

			for (const task of tasks) {
				let icon: string;
				let mainColor: string;
				switch (task.status) {
					case "done":
						icon = th.fg("success", STATUS_ICON.done);
						mainColor = "dim";
						break;
					case "inprogress":
						icon = th.fg("accent", STATUS_ICON.inprogress);
						mainColor = "success";
						break;
					case "blocked":
						icon = th.fg("error", STATUS_ICON.blocked);
						mainColor = "warning";
						break;
					case "skipped":
						icon = th.fg("dim", STATUS_ICON.skipped);
						mainColor = "dim";
						break;
					default:
						icon = th.fg("dim", STATUS_ICON.idle);
						mainColor = "muted";
				}

				const imp = task.importance !== "normal" ? th.fg("dim", ` · ${task.importance}`) : "";
				const elapsed = th.fg("dim", ` · ${formatElapsedLive(task)}`);
				lines.push(truncateToWidth(`  ${icon} ${th.fg("accent", `#${task.id}`)} ${th.fg(mainColor as Parameters<Theme["fg"]>[0], task.text)}${imp}${elapsed}`, width));

				if (task.status === "blocked" && task.blockedReason) {
					lines.push(truncateToWidth(`     ${th.fg("error", `blocked: ${task.blockedReason}`)}`, width));
				}
				if (task.status === "skipped" && task.skippedReason) {
					lines.push(truncateToWidth(`     ${th.fg("dim", `skipped: ${task.skippedReason}`)}`, width));
				}
				if (task.status === "done") {
					if (task.doneNote) lines.push(truncateToWidth(`     ${th.fg("dim", `note: ${task.doneNote}`)}`, width));
					if (task.evidence && task.evidence.length > 0)
						lines.push(truncateToWidth(`     ${th.fg("dim", `evidence: ${task.evidence.join(", ")}`)}`, width));
				}
				if (task.acceptance && task.acceptance.length > 0 && !isClosedStatus(task.status)) {
					lines.push(truncateToWidth(`     ${th.fg("dim", `acceptance: ${task.acceptance.join(" | ")}`)}`, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedVersion = version;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedVersion = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension entry point ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── State ────────────────────────────────────────────────────────────────

	let tasks: WorkflowTask[] = [];
	let nextId = 1;
	let listTitle: string | undefined;
	let listDescription: string | undefined;
	let nudgedThisCycle = false;
	let nudgeCounts: Record<number, number> = {};
	let toolCounts: Record<string, number> = {};
	let stateVersion = 0;
	let finalSummaryEmittedForVersion: number | undefined;
	let lastKnownBranchTokens = { input: 0, output: 0 };
	let overlayTui: { requestRender(): void } | undefined;

	// ── Snapshot & details ────────────────────────────────────────────────────

	const makeSnapshot = (): WorkflowSnapshot => ({
		tasks: tasks.map(cloneTask),
		nextId,
		listTitle,
		listDescription,
		nudgedThisCycle,
		nudgeCounts: { ...nudgeCounts },
		toolCounts: { ...toolCounts },
		stateVersion,
		finalSummaryEmittedForVersion,
	});

	const makeDetails = (action: string, error?: string): WorkflowDetails => ({
		action,
		snapshot: makeSnapshot(),
		...(error ? { error } : {}),
	});

	const bumpVersion = () => { stateVersion++; };

	// ── UI refresh ────────────────────────────────────────────────────────────

	const refreshUI = (ctx: ExtensionContext) => {
		// Status line
		const total = tasks.length;
		if (total === 0) {
			ctx.ui.setStatus(listTitle ? `Workflow: ${listTitle} · no tasks` : "Workflow: no list", "workflow");
		} else {
			const closed = tasks.filter((t) => isClosedStatus(t.status)).length;
			const blocked = tasks.filter((t) => t.status === "blocked").length;
			const pct = Math.round((closed / total) * 100);
			const active = tasks.find((t) => t.status === "inprogress");
			const title = listTitle || "Workflow";
			let status = `Workflow: ${title} · ${pct}% [${progressBar(pct)}] · ${closed}/${total} closed`;
			if (blocked > 0) status += ` · blocked: ${blocked}`;
			if (active) status += ` · #${active.id} ${active.text}`;
			ctx.ui.setStatus(status, "workflow");
		}

		// Current task widget
		const current = tasks.find((t) => t.status === "inprogress");
		if (!current) {
			ctx.ui.setWidget("workflow-current", undefined);
		} else {
			ctx.ui.setWidget(
				"workflow-current",
				(_tui, theme) => {
					return {
						render(width: number): string[] {
							const cur = tasks.find((t) => t.status === "inprogress");
							if (!cur) return [];

							const elapsed = formatElapsedLive(cur);
							const toolEntries = Object.entries(cur.usage.toolCalls);
							const toolStr = toolEntries.length > 0 ? toolEntries.map(([n, c]) => `${n}=${c}`).join(" ") : "";
							const usageStr =
								cur.usage.inputTokens > 0 || cur.usage.outputTokens > 0
									? ` · in: ${fmtTok(cur.usage.inputTokens)} out: ${fmtTok(cur.usage.outputTokens)}`
									: "";

							const sepLine = theme.fg("borderMuted", "─".repeat(width));
							const titleLine = truncateToWidth(
								`${theme.fg("dim", (listTitle || "Workflow") + " /")} ${theme.fg("accent", `#${cur.id}`)} ${theme.fg("success", cur.text)}` +
									(cur.importance !== "normal" ? theme.fg("dim", ` · ${cur.importance}`) : ""),
								width,
								"",
							);
							const statsLine = truncateToWidth(
								`${theme.fg("dim", elapsed)}` +
									(toolStr ? theme.fg("dim", ` · ${toolStr}`) : "") +
									theme.fg("dim", usageStr),
								width,
								"",
							);
							return [sepLine, titleLine, statsLine];
						},
						invalidate() {},
					};
				},
				{ placement: "belowEditor" },
			);
		}

		// Footer
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// Token totals from branch
					let tokIn = 0;
					let tokOut = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							tokIn += m.usage.input;
							tokOut += m.usage.output;
						}
					}

					// Line 1: model · context bar · cwd · branch (left) | tokens · tool counts (right)
					const usage = ctx.getContextUsage();
					const ctxPct = usage ? usage.percent : 0;
					const filled = Math.min(10, Math.max(0, Math.round(ctxPct / 10)));
					const model = ctx.model?.id || "no-model";
					const branch = footerData.getGitBranch();

					const l1Left =
						theme.fg("dim", ` ${model} `) +
						theme.fg("warning", "[") +
						theme.fg("success", "█".repeat(filled)) +
						theme.fg("dim", "░".repeat(10 - filled)) +
						theme.fg("warning", "]") +
						theme.fg("dim", " ") +
						theme.fg("accent", `${Math.round(ctxPct)}%`) +
						theme.fg("dim", ` ${ctx.cwd}`) +
						(branch
							? theme.fg("dim", " ") + theme.fg("warning", "(") + theme.fg("success", branch) + theme.fg("warning", ")")
							: "");
					const tcEntries = Object.entries(toolCounts);
					const l1Right =
						theme.fg("dim", "in: ") +
						theme.fg("success", fmtTok(tokIn)) +
						theme.fg("dim", " · out: ") +
						theme.fg("accent", fmtTok(tokOut)) +
						theme.fg("dim", " · ") +
						(tcEntries.length === 0
							? theme.fg("dim", "waiting for tools ")
							: tcEntries.map(([n, c]) => theme.fg("accent", n) + theme.fg("dim", "=") + theme.fg("success", `${c}`)).join(theme.fg("dim", " ")) +
								theme.fg("dim", " "));
					const l1Pad = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
					const line1 = truncateToWidth(l1Left + l1Pad + l1Right, width, "");

					// Workflow header line
					const tot = tasks.length;
					if (tot === 0) {
						const wfLeft =
							theme.fg("accent", " Workflow") + (listTitle ? theme.fg("dim", `: ${listTitle}`) : "") + theme.fg("dim", " · no tasks");
						return [line1, truncateToWidth(wfLeft, width, "")];
					}

					const doneC = tasks.filter((t) => t.status === "done").length;
					const skippedC = tasks.filter((t) => t.status === "skipped").length;
					const blockedC = tasks.filter((t) => t.status === "blocked").length;
					const activeC = tasks.filter((t) => t.status === "inprogress").length;
					const idleC = tasks.filter((t) => t.status === "idle").length;
					const closedC = doneC + skippedC;
					const closedPct = Math.round((closedC / tot) * 100);

					const wfLeft =
						theme.fg("accent", " Workflow") +
						(listTitle ? theme.fg("dim", `: ${listTitle}`) : "") +
						theme.fg("dim", " · ") +
						theme.fg("accent", `${closedPct}%`) +
						theme.fg("dim", ` [${progressBar(closedPct)}]`);
					const wfRight =
						theme.fg("dim", `closed:${closedC}/${tot} · idle:${idleC} active:${activeC} blocked:${blockedC} skipped:${skippedC} `);
					const wfPad = " ".repeat(Math.max(1, width - visibleWidth(wfLeft) - visibleWidth(wfRight)));
					const wfLine = truncateToWidth(wfLeft + wfPad + wfRight, width, "");

					// Task detail rows: inprogress first, then blocked, then recent done
					const inprogressTasks = tasks.filter((t) => t.status === "inprogress");
					const blockedTasks = tasks.filter((t) => t.status === "blocked");
					const recentDone = tasks
						.filter((t) => t.status === "done")
						.reverse()
						.slice(0, 2);
					const visible = [...inprogressTasks, ...blockedTasks, ...recentDone].slice(0, 5);
					const remaining = tot - visible.length;

					const rows = visible.map((t) => {
						const icon =
							t.status === "done"
								? theme.fg("success", STATUS_ICON.done)
								: t.status === "inprogress"
									? theme.fg("accent", STATUS_ICON.inprogress)
									: t.status === "blocked"
										? theme.fg("error", STATUS_ICON.blocked)
										: t.status === "skipped"
											? theme.fg("dim", STATUS_ICON.skipped)
											: theme.fg("dim", STATUS_ICON.idle);

						let row = ` ${icon} ${theme.fg("accent", `#${t.id}`)} `;
						if (t.status === "inprogress") {
							const toolStr = Object.entries(t.usage.toolCalls)
								.map(([n, c]) => `${n}=${c}`)
								.join(" ");
							row +=
								theme.fg("success", t.text) +
								theme.fg("dim", ` · ${t.importance}`) +
								theme.fg("dim", ` · ${formatElapsedLive(t)}`) +
								(toolStr ? theme.fg("dim", ` · ${toolStr}`) : "");
							if (t.usage.inputTokens > 0 || t.usage.outputTokens > 0) {
								row += theme.fg("dim", ` · in: ${fmtTok(t.usage.inputTokens)} out: ${fmtTok(t.usage.outputTokens)}`);
							}
						} else if (t.status === "blocked") {
							row += theme.fg("warning", t.text) + theme.fg("error", ` · blocked: ${t.blockedReason || "–"}`);
						} else if (t.status === "done") {
							row += theme.fg("dim", t.text);
							row += theme.fg("dim", ` · ${formatElapsed(t.elapsedMs)}`);
							if (t.usage.inputTokens > 0 || t.usage.outputTokens > 0) {
								row += theme.fg("dim", ` · in: ${fmtTok(t.usage.inputTokens)} out: ${fmtTok(t.usage.outputTokens)}`);
							}
							if (t.evidence && t.evidence.length > 0) row += theme.fg("dim", ` · evidence: ${t.evidence[0]}`);
						} else {
							row += theme.fg("muted", t.text);
						}
						return truncateToWidth(row, width, "");
					});

					if (remaining > 0) {
						rows.push(truncateToWidth(theme.fg("dim", `  +${remaining} more`), width, ""));
					}

					return [line1, wfLine, ...rows];
				},
			};
		});

		// Invalidate overlay if open
		if (overlayTui) overlayTui.requestRender();
	};

	// ── State reconstruction ──────────────────────────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		tasks = [];
		nextId = 1;
		listTitle = undefined;
		listDescription = undefined;
		nudgedThisCycle = false;
		nudgeCounts = {};
		toolCounts = {};
		stateVersion = 0;
		finalSummaryEmittedForVersion = undefined;
		lastKnownBranchTokens = { input: 0, output: 0 };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "workflow") continue;
			const details = msg.details as WorkflowDetails | undefined;
			if (details?.snapshot) {
				const snap = details.snapshot;
				tasks = snap.tasks.map(cloneTask);
				nextId = snap.nextId;
				listTitle = snap.listTitle;
				listDescription = snap.listDescription;
				nudgedThisCycle = snap.nudgedThisCycle ?? false;
				nudgeCounts = { ...(snap.nudgeCounts ?? {}) };
				toolCounts = { ...(snap.toolCounts ?? {}) };
				stateVersion = snap.stateVersion ?? 0;
				finalSummaryEmittedForVersion = snap.finalSummaryEmittedForVersion;
			}
		}

		// Reconstruct lastKnownBranchTokens
		let tokIn = 0;
		let tokOut = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				tokIn += m.usage.input;
				tokOut += m.usage.output;
			}
		}
		lastKnownBranchTokens = { input: tokIn, output: tokOut };

		refreshUI(ctx);
	};

	// ── Event handlers ────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("input", async () => {
		nudgedThisCycle = false;
		return { action: "continue" as const };
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const toolName = event.toolName;

		// Ignore ctx_ prefixed tools entirely
		if (toolName.startsWith("ctx_")) return;

		// Global tool count
		toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;

		// Per-task tool count (not for workflow administrative calls)
		if (toolName !== "workflow") {
			const activeTask = tasks.find((t) => t.status === "inprogress");
			if (activeTask) {
				activeTask.usage.toolCalls[toolName] = (activeTask.usage.toolCalls[toolName] || 0) + 1;
			}
		}

		// Token delta: compute current totals from branch, diff from last known
		let tokIn = 0;
		let tokOut = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				tokIn += m.usage.input;
				tokOut += m.usage.output;
			}
		}
		const deltaIn = Math.max(0, tokIn - lastKnownBranchTokens.input);
		const deltaOut = Math.max(0, tokOut - lastKnownBranchTokens.output);
		lastKnownBranchTokens = { input: tokIn, output: tokOut };

		if (toolName !== "workflow" && (deltaIn > 0 || deltaOut > 0)) {
			const activeTask = tasks.find((t) => t.status === "inprogress");
			if (activeTask) {
				activeTask.usage.inputTokens += deltaIn;
				activeTask.usage.outputTokens += deltaOut;
			}
		}

		refreshUI(ctx);
	});

	// ── Blocking gate ──────────────────────────────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		const toolName = event.toolName;

		// Never block the workflow tool itself
		if (toolName === "workflow") return { block: false };

		// Never block ctx_ prefixed tools
		if (toolName.startsWith("ctx_")) return { block: false };

		// No list created
		if (!listTitle) {
			return {
				block: true,
				reason: "🚫 No Workflow list defined. Use `workflow new-list` to create a list, then `workflow add` to add tasks before using any other tools.",
			};
		}

		// List exists but empty
		if (tasks.length === 0) {
			return {
				block: true,
				reason: "🚫 Your Workflow list has no tasks. Use `workflow add` to define what you will work on before using any other tools.",
			};
		}

		const pending = tasks.filter((t) => !isClosedStatus(t.status));
		const active = tasks.filter((t) => t.status === "inprogress");
		const blockedTasks = tasks.filter((t) => t.status === "blocked");

		// All tasks closed
		if (pending.length === 0) {
			return {
				block: true,
				reason: "🚫 All Workflow tasks are closed (done or skipped). Use `workflow add` to add new tasks or `workflow new-list` to start a fresh list.",
			};
		}

		// No active task
		if (active.length === 0) {
			if (blockedTasks.length > 0 && pending.every((t) => t.status === "blocked")) {
				const blockList = blockedTasks.map((t) => `  ■ #${t.id} ${t.text}: ${t.blockedReason}`).join("\n");
				return {
					block: true,
					reason: `🚫 All pending Workflow tasks are blocked:\n${blockList}\n\nUse \`workflow unblock #<id>\`, \`workflow skip #<id> reason=...\`, or ask the user for help.`,
				};
			}
			return {
				block: true,
				reason: "🚫 No Workflow task is in progress. Call `workflow list` to see available tasks, then `workflow start #<id>` to begin one.",
			};
		}

		// Multiple active tasks — corrupted state
		if (active.length > 1) {
			return {
				block: true,
				reason: `🚫 Multiple Workflow tasks are in progress (${active.map((t) => `#${t.id}`).join(", ")}). This is a corrupted state. Use \`workflow pause #<id>\` to pause all but one.`,
			};
		}

		return { block: false };
	});

	// ── Agent end: nudge & smart final summary ────────────────────────────────

	pi.on("agent_end", async (_event, _ctx) => {
		if (!listTitle && tasks.length === 0) return;

		const allClosed = tasks.length > 0 && tasks.every((t) => isClosedStatus(t.status));

		// Smart final summary (once per stateVersion)
		if (allClosed && finalSummaryEmittedForVersion !== stateVersion) {
			finalSummaryEmittedForVersion = stateVersion;

			const taskLines = tasks
				.map((t) => {
					if (t.status === "done") {
						let line = `  ✓ #${t.id} ${t.text} — ${formatElapsed(t.elapsedMs)}`;
						if (t.doneNote) line += ` — ${t.doneNote}`;
						if (t.evidence && t.evidence.length > 0) line += ` — evidence: ${t.evidence.join(", ")}`;
						return line;
					}
					return `  ↷ #${t.id} ${t.text} — skipped: ${t.skippedReason || "–"}`;
				})
				.join("\n");

			const toolLines = Object.entries(toolCounts)
				.filter(([name]) => name !== "workflow")
				.map(([name, count]) => `  - ${name}: ${count}`)
				.join("\n");

			const summary = [
				`✅ Workflow complete: ${listTitle || "–"}`,
				"",
				"Tasks:",
				taskLines,
				...(toolLines ? ["", "Tools used:", toolLines] : []),
			].join("\n");

			pi.sendMessage({ customType: "workflow-summary", content: summary, display: true }, { triggerTurn: false });
			return;
		}

		// Nudge for incomplete tasks
		const incomplete = tasks.filter((t) => !isClosedStatus(t.status));
		if (incomplete.length === 0 || nudgedThisCycle) return;

		nudgedThisCycle = true;

		const inprogress = tasks.filter((t) => t.status === "inprogress");
		const blockedTasks = tasks.filter((t) => t.status === "blocked");
		const idleTasks = tasks.filter((t) => t.status === "idle");
		let nudgeMsg = "";

		if (inprogress.length > 0) {
			const cur = inprogress[0];
			nudgeCounts[cur.id] = (nudgeCounts[cur.id] || 0) + 1;
			const count = nudgeCounts[cur.id];
			const acceptanceNote =
				cur.acceptance && cur.acceptance.length > 0 ? " Check acceptance criteria before marking done." : "";
			if (count >= 3) {
				nudgeMsg =
					`⚠️ You have been nudged ${count} times about task #${cur.id}. This task needs resolution.\n\n` +
					`  ● #${cur.id} ${cur.text}\n\n` +
					`Complete it with \`workflow done #${cur.id}\`, block it with \`workflow block #${cur.id} reason=...\`, or pause it and work on something else.`;
			} else {
				nudgeMsg =
					`⚠️ You have an in-progress Workflow task that is not marked done:\n\n` +
					`  ● #${cur.id} ${cur.text}\n\n` +
					`Either continue working on it, mark it done with \`workflow done #${cur.id}\`${acceptanceNote}, block it with a reason, or pause it.`;
			}
		} else if (idleTasks.length > 0) {
			const next = idleTasks[0];
			const taskList = idleTasks
				.slice(0, 3)
				.map((t) => `  ○ #${t.id} ${t.text} (${t.importance})`)
				.join("\n");
			nudgeMsg =
				`⚠️ No Workflow task is in progress. Start the next task:\n\n${taskList}\n\n` +
				`Use \`workflow start #${next.id}\` to begin.`;
		} else if (blockedTasks.length > 0) {
			const blockList = blockedTasks.map((t) => `  ■ #${t.id} ${t.text}: ${t.blockedReason}`).join("\n");
			nudgeMsg =
				`⚠️ All pending Workflow tasks are blocked:\n\n${blockList}\n\n` +
				`Use \`workflow unblock #<id>\` to unblock, \`workflow skip #<id> reason=...\` to skip, or ask the user for help.`;
		}

		if (nudgeMsg) {
			pi.sendMessage({ customType: "workflow-nudge", content: nudgeMsg, display: true }, { triggerTurn: true });
		}
	});

	// ── Tool ──────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Manage your Workflow task list. " +
			"MANDATORY AGENT RULES: " +
			"(1) Always call `workflow list` first to check current state before working on an existing list. " +
			"(2) If the user's new request does not fit the current list's theme, use `clear` then `new-list`. " +
			"(3) Before any new work, call `workflow new-list`; `add` requires an existing list. " +
			"(4) Only `idle` tasks can be started with `start`. " +
			"(5) When finished, use `done` with `note` and/or `evidence` to document completion. " +
			"(6) Never reopen a done task. " +
			"(7) Use `block` for obstacles, `skip` for deliberate exclusions — not `remove`. " +
			"(8) `remove` is only for mistakenly added tasks. " +
			"(9) No cyclic toggle action exists or should be used. " +
			"Actions: new-list (text=title, description?), list, " +
			"add (text or texts[], importance?, acceptance?), " +
			"start (id), done (id, note?, evidence?), pause (id), " +
			"block (id, reason), unblock (id), skip (id, reason), " +
			"remove (id), update (id, text?, importance?, acceptance?), " +
			"move (id, position|beforeId|afterId), clear.",
		parameters: WorkflowParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const now = Date.now();

			switch (params.action) {
				// ── new-list ──────────────────────────────────────────────────────
				case "new-list": {
					if (!params.text?.trim()) {
						return {
							content: [{ type: "text" as const, text: "Error: text (title) is required for new-list" }],
							details: makeDetails("new-list", "text required"),
						};
					}

					if (tasks.length > 0 || listTitle) {
						const confirmed = await ctx.ui.confirm(
							"Start a new Workflow list?",
							`This will replace${listTitle ? ` "${listTitle}"` : " the current list"} (${tasks.length} task(s)). Continue?`,
							{ timeout: 30000 },
						);
						if (!confirmed) {
							return {
								content: [{ type: "text" as const, text: "New list cancelled by user." }],
								details: makeDetails("new-list", "cancelled"),
							};
						}
					}

					tasks = [];
					nextId = 1;
					listTitle = params.text.trim();
					listDescription = params.description?.trim() || undefined;
					nudgeCounts = {};
					toolCounts = {};
					finalSummaryEmittedForVersion = undefined;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `New Workflow list: "${listTitle}"${listDescription ? ` — ${listDescription}` : ""}` }],
						details: makeDetails("new-list"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── list ──────────────────────────────────────────────────────────
				case "list": {
					const header = listTitle ? `Workflow: ${listTitle}` : "Workflow";
					const descLine = listDescription ? `\n${listDescription}` : "";

					if (tasks.length === 0) {
						return {
							content: [{ type: "text" as const, text: `${header}${descLine}\n\nNo tasks defined yet.` }],
							details: makeDetails("list"),
						};
					}

					const total = tasks.length;
					const closed = tasks.filter((t) => isClosedStatus(t.status)).length;
					const pct = Math.round((closed / total) * 100);

					const taskLines = tasks
						.map((t) => {
							const imp = t.importance !== "normal" ? ` [${t.importance}]` : "";
							const elapsed = ` (${formatElapsedLive(t)})`;
							let line = `${STATUS_ICON[t.status]} #${t.id} (${t.status})${imp}: ${t.text}${elapsed}`;
							if (t.status === "blocked" && t.blockedReason) line += `\n   blocked: ${t.blockedReason}`;
							if (t.status === "skipped" && t.skippedReason) line += `\n   skipped: ${t.skippedReason}`;
							if (t.status === "done" && t.doneNote) line += `\n   note: ${t.doneNote}`;
							if (t.acceptance && t.acceptance.length > 0 && !isClosedStatus(t.status)) {
								line += `\n   acceptance: ${t.acceptance.join(" | ")}`;
							}
							return line;
						})
						.join("\n");

					refreshUI(ctx);
					return {
						content: [{ type: "text" as const, text: `${header}${descLine}\nProgress: ${pct}% [${progressBar(pct)}] · ${closed}/${total} closed\n\n${taskLines}` }],
						details: makeDetails("list"),
					};
				}

				// ── add ───────────────────────────────────────────────────────────
				case "add": {
					if (!listTitle) {
						return {
							content: [{ type: "text" as const, text: "Error: No active Workflow list. Use `workflow new-list` first." }],
							details: makeDetails("add", "no active list"),
						};
					}

					const items = params.texts?.length ? params.texts : params.text ? [params.text] : [];
					if (items.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: text or texts required for add" }],
							details: makeDetails("add", "text required"),
						};
					}

					if (items.some((s) => !s.trim())) {
						return {
							content: [{ type: "text" as const, text: "Error: Empty task text is not allowed" }],
							details: makeDetails("add", "empty task text"),
						};
					}

					const acceptance = params.acceptance?.map((s) => s.trim()).filter(Boolean);
					const importance: WorkflowTaskImportance = params.importance || "normal";
					const added: WorkflowTask[] = [];

					for (const item of items) {
						const t: WorkflowTask = {
							id: nextId++,
							text: item.trim(),
							status: "idle",
							importance,
							acceptance: acceptance && acceptance.length > 0 ? acceptance : undefined,
							createdAt: now,
							elapsedMs: 0,
							usage: { inputTokens: 0, outputTokens: 0, toolCalls: {} },
						};
						tasks.push(t);
						added.push(t);
					}

					bumpVersion();
					const msg =
						added.length === 1
							? `Added task #${added[0].id}: ${added[0].text}`
							: `Added ${added.length} tasks: ${added.map((t) => `#${t.id}`).join(", ")}`;

					const result = {
						content: [{ type: "text" as const, text: msg }],
						details: makeDetails("add"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── start ─────────────────────────────────────────────────────────
				case "start": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for start" }],
							details: makeDetails("start", "id required"),
						};
					}

					const startTask = tasks.find((t) => t.id === params.id);
					if (!startTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("start", `#${params.id} not found`),
						};
					}

					if (startTask.status === "done") {
						return {
							content: [{ type: "text" as const, text: `Error: Task #${startTask.id} is already done and cannot be restarted.` }],
							details: makeDetails("start", `#${startTask.id} is done`),
						};
					}
					if (startTask.status === "skipped") {
						return {
							content: [{ type: "text" as const, text: `Error: Task #${startTask.id} is skipped and cannot be restarted.` }],
							details: makeDetails("start", `#${startTask.id} is skipped`),
						};
					}
					if (startTask.status === "blocked") {
						return {
							content: [{ type: "text" as const, text: `Error: Task #${startTask.id} is blocked (${startTask.blockedReason}). Use \`workflow unblock #${startTask.id}\` first.` }],
							details: makeDetails("start", `#${startTask.id} is blocked`),
						};
					}
					if (startTask.status === "inprogress") {
						return {
							content: [{ type: "text" as const, text: `Task #${startTask.id} is already in progress.` }],
							details: makeDetails("start"),
						};
					}

					// Auto-pause any other inprogress task
					const autoPaused: WorkflowTask[] = [];
					for (const t of tasks) {
						if (t.id !== startTask.id && t.status === "inprogress") {
							flushElapsed(t);
							t.status = "idle";
							t.updatedAt = now;
							autoPaused.push(t);
						}
					}

					startTask.status = "inprogress";
					startTask.startedAt = now;
					startTask.updatedAt = now;
					bumpVersion();

					let msg = `Started #${startTask.id}: ${startTask.text}`;
					if (autoPaused.length > 0) {
						msg += `\n(Auto-paused ${autoPaused.map((t) => `#${t.id}`).join(", ")} → idle.)`;
					}

					const result = {
						content: [{ type: "text" as const, text: msg }],
						details: makeDetails("start"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── done ──────────────────────────────────────────────────────────
				case "done": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for done" }],
							details: makeDetails("done", "id required"),
						};
					}

					const doneTask = tasks.find((t) => t.id === params.id);
					if (!doneTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("done", `#${params.id} not found`),
						};
					}

					if (doneTask.status === "done") {
						return {
							content: [{ type: "text" as const, text: `Task #${doneTask.id} is already done.` }],
							details: makeDetails("done"),
						};
					}

					if (doneTask.status !== "inprogress") {
						return {
							content: [{ type: "text" as const, text: `Error: Only inprogress tasks can be marked done. Task #${doneTask.id} is "${doneTask.status}". Use \`workflow start #${doneTask.id}\` first.` }],
							details: makeDetails("done", `#${doneTask.id} is not inprogress`),
						};
					}

					flushElapsed(doneTask);
					const evidence = params.evidence?.map((s) => s.trim()).filter(Boolean);
					doneTask.status = "done";
					doneTask.doneNote = params.note?.trim() || undefined;
					doneTask.evidence = evidence && evidence.length > 0 ? evidence : undefined;
					doneTask.completedAt = now;
					doneTask.startedAt = undefined;
					doneTask.updatedAt = now;
					bumpVersion();

					let msg = `Done #${doneTask.id}: ${doneTask.text} (${formatElapsed(doneTask.elapsedMs)})`;
					if (doneTask.doneNote) msg += `\nnote: ${doneTask.doneNote}`;
					if (doneTask.evidence && doneTask.evidence.length > 0) msg += `\nevidence: ${doneTask.evidence.join(", ")}`;
					if (doneTask.acceptance && doneTask.acceptance.length > 0) {
						msg += `\n⚠️ This task has acceptance criteria. Ensure they are satisfied:\n${doneTask.acceptance.map((a) => `  - ${a}`).join("\n")}`;
					}

					const result = {
						content: [{ type: "text" as const, text: msg }],
						details: makeDetails("done"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── pause ─────────────────────────────────────────────────────────
				case "pause": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for pause" }],
							details: makeDetails("pause", "id required"),
						};
					}

					const pauseTask = tasks.find((t) => t.id === params.id);
					if (!pauseTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("pause", `#${params.id} not found`),
						};
					}

					if (pauseTask.status !== "inprogress") {
						return {
							content: [{ type: "text" as const, text: `Task #${pauseTask.id} is not in progress (status: ${pauseTask.status}). Only inprogress tasks can be paused.` }],
							details: makeDetails("pause", `#${pauseTask.id} not inprogress`),
						};
					}

					flushElapsed(pauseTask);
					pauseTask.status = "idle";
					pauseTask.startedAt = undefined;
					pauseTask.updatedAt = now;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Paused #${pauseTask.id}: ${pauseTask.text} (→ idle)` }],
						details: makeDetails("pause"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── block ─────────────────────────────────────────────────────────
				case "block": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for block" }],
							details: makeDetails("block", "id required"),
						};
					}
					if (!params.reason?.trim()) {
						return {
							content: [{ type: "text" as const, text: "Error: reason is required for block" }],
							details: makeDetails("block", "reason required"),
						};
					}

					const blockTask = tasks.find((t) => t.id === params.id);
					if (!blockTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("block", `#${params.id} not found`),
						};
					}

					if (isClosedStatus(blockTask.status)) {
						return {
							content: [{ type: "text" as const, text: `Error: Task #${blockTask.id} is already closed (${blockTask.status}) and cannot be blocked.` }],
							details: makeDetails("block", `#${blockTask.id} is closed`),
						};
					}

					if (blockTask.status === "inprogress") flushElapsed(blockTask);

					blockTask.status = "blocked";
					blockTask.blockedReason = params.reason.trim();
					blockTask.startedAt = undefined;
					blockTask.updatedAt = now;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Blocked #${blockTask.id}: ${blockTask.text}\nReason: ${blockTask.blockedReason}` }],
						details: makeDetails("block"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── unblock ───────────────────────────────────────────────────────
				case "unblock": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for unblock" }],
							details: makeDetails("unblock", "id required"),
						};
					}

					const unblockTask = tasks.find((t) => t.id === params.id);
					if (!unblockTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("unblock", `#${params.id} not found`),
						};
					}

					if (unblockTask.status !== "blocked") {
						return {
							content: [{ type: "text" as const, text: `Task #${unblockTask.id} is not blocked (status: ${unblockTask.status}).` }],
							details: makeDetails("unblock", `#${unblockTask.id} not blocked`),
						};
					}

					unblockTask.status = "idle";
					unblockTask.blockedReason = undefined;
					unblockTask.updatedAt = now;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Unblocked #${unblockTask.id}: ${unblockTask.text} (→ idle)` }],
						details: makeDetails("unblock"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── skip ──────────────────────────────────────────────────────────
				case "skip": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for skip" }],
							details: makeDetails("skip", "id required"),
						};
					}
					if (!params.reason?.trim()) {
						return {
							content: [{ type: "text" as const, text: "Error: reason is required for skip" }],
							details: makeDetails("skip", "reason required"),
						};
					}

					const skipTask = tasks.find((t) => t.id === params.id);
					if (!skipTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("skip", `#${params.id} not found`),
						};
					}

					if (skipTask.status === "done") {
						return {
							content: [{ type: "text" as const, text: `Error: Task #${skipTask.id} is already done and cannot be skipped.` }],
							details: makeDetails("skip", `#${skipTask.id} is done`),
						};
					}

					if (skipTask.status === "inprogress") flushElapsed(skipTask);

					skipTask.status = "skipped";
					skipTask.skippedReason = params.reason.trim();
					skipTask.completedAt = now;
					skipTask.startedAt = undefined;
					skipTask.updatedAt = now;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Skipped #${skipTask.id}: ${skipTask.text}\nReason: ${skipTask.skippedReason}` }],
						details: makeDetails("skip"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── remove ────────────────────────────────────────────────────────
				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for remove" }],
							details: makeDetails("remove", "id required"),
						};
					}

					const removeIdx = tasks.findIndex((t) => t.id === params.id);
					if (removeIdx === -1) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("remove", `#${params.id} not found`),
						};
					}

					const removed = tasks.splice(removeIdx, 1)[0];
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Removed task #${removed.id}: ${removed.text}\nNote: Use \`workflow skip\` instead of remove to preserve audit trail for deliberate exclusions.` }],
						details: makeDetails("remove"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── update ────────────────────────────────────────────────────────
				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for update" }],
							details: makeDetails("update", "id required"),
						};
					}

					const updateTask = tasks.find((t) => t.id === params.id);
					if (!updateTask) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("update", `#${params.id} not found`),
						};
					}

					if (updateTask.status === "done") {
						return {
							content: [{ type: "text" as const, text: `Error: Task #${updateTask.id} is done and cannot be updated (audit trail protection).` }],
							details: makeDetails("update", `#${updateTask.id} is done`),
						};
					}

					if (params.text === undefined && params.importance === undefined && params.acceptance === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: At least one of text, importance, or acceptance must be provided for update" }],
							details: makeDetails("update", "nothing to update"),
						};
					}

					if (params.text !== undefined) {
						if (!params.text.trim()) {
							return {
								content: [{ type: "text" as const, text: "Error: text cannot be empty" }],
								details: makeDetails("update", "empty text"),
							};
						}
						updateTask.text = params.text.trim();
					}
					if (params.importance !== undefined) updateTask.importance = params.importance;
					if (params.acceptance !== undefined) {
						const cleaned = params.acceptance.map((s) => s.trim()).filter(Boolean);
						updateTask.acceptance = cleaned.length > 0 ? cleaned : undefined;
					}
					updateTask.updatedAt = now;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Updated #${updateTask.id}: ${updateTask.text}` }],
						details: makeDetails("update"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── move ──────────────────────────────────────────────────────────
				case "move": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for move" }],
							details: makeDetails("move", "id required"),
						};
					}
					if (params.position === undefined && params.beforeId === undefined && params.afterId === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: One of position, beforeId, or afterId is required for move" }],
							details: makeDetails("move", "target required"),
						};
					}

					const moveIdx = tasks.findIndex((t) => t.id === params.id);
					if (moveIdx === -1) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("move", `#${params.id} not found`),
						};
					}

					const [moveTask] = tasks.splice(moveIdx, 1);
					let targetIdx: number;

					if (params.position !== undefined) {
						targetIdx = Math.max(0, Math.min(tasks.length, params.position - 1));
					} else if (params.beforeId !== undefined) {
						const refIdx = tasks.findIndex((t) => t.id === params.beforeId);
						if (refIdx === -1) {
							tasks.splice(moveIdx, 0, moveTask);
							return {
								content: [{ type: "text" as const, text: `Reference task #${params.beforeId} not found` }],
								details: makeDetails("move", `#${params.beforeId} not found`),
							};
						}
						targetIdx = refIdx;
					} else {
						const refIdx = tasks.findIndex((t) => t.id === params.afterId);
						if (refIdx === -1) {
							tasks.splice(moveIdx, 0, moveTask);
							return {
								content: [{ type: "text" as const, text: `Reference task #${params.afterId} not found` }],
								details: makeDetails("move", `#${params.afterId} not found`),
							};
						}
						targetIdx = refIdx + 1;
					}

					tasks.splice(targetIdx, 0, moveTask);
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Moved #${moveTask.id} to position ${targetIdx + 1}` }],
						details: makeDetails("move"),
					};
					refreshUI(ctx);
					return result;
				}

				// ── clear ─────────────────────────────────────────────────────────
				case "clear": {
					if (tasks.length > 0 || listTitle) {
						const confirmed = await ctx.ui.confirm(
							"Clear Workflow list?",
							`This will remove all ${tasks.length} task(s)${listTitle ? ` from "${listTitle}"` : ""}. Continue?`,
							{ timeout: 30000 },
						);
						if (!confirmed) {
							return {
								content: [{ type: "text" as const, text: "Clear cancelled by user." }],
								details: makeDetails("clear", "cancelled"),
							};
						}
					}

					const count = tasks.length;
					tasks = [];
					nextId = 1;
					listTitle = undefined;
					listDescription = undefined;
					nudgeCounts = {};
					toolCounts = {};
					finalSummaryEmittedForVersion = undefined;
					bumpVersion();

					const result = {
						content: [{ type: "text" as const, text: `Cleared Workflow list (${count} task(s) removed)` }],
						details: makeDetails("clear"),
					};
					refreshUI(ctx);
					return result;
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${(params as { action: string }).action}` }],
						details: makeDetails("list", "unknown action"),
					};
			}
		},

		// ── renderCall ──────────────────────────────────────────────────────────
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("muted", args.action);
			if (args.texts?.length) text += theme.fg("dim", ` ${args.texts.length} tasks`);
			else if (args.text) text += theme.fg("dim", ` "${args.text}"`);
			if (args.description) text += theme.fg("dim", ` — ${args.description}`);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.importance && args.importance !== "normal") text += theme.fg("dim", ` [${args.importance}]`);
			if (args.reason) text += theme.fg("dim", ` reason: "${args.reason}"`);
			if (args.note) text += theme.fg("dim", ` note: "${args.note}"`);
			if (args.evidence?.length) text += theme.fg("dim", ` evidence: ${args.evidence.length}`);
			if (args.position !== undefined) text += theme.fg("dim", ` pos: ${args.position}`);
			return new Text(text, 0, 0);
		},

		// ── renderResult ────────────────────────────────────────────────────────
		renderResult(result, { expanded }, theme) {
			const details = result.details as WorkflowDetails | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}

			if (details.error) {
				if (details.error === "cancelled") return new Text(theme.fg("warning", "⊘ Cancelled"), 0, 0);
				return new Text(theme.fg("error", `✕ ${details.error}`), 0, 0);
			}

			const snap = details.snapshot;
			const taskList = snap.tasks;
			const firstLine = result.content[0]?.type === "text" ? result.content[0].text : "";

			switch (details.action) {
				case "new-list": {
					let msg = theme.fg("success", "✓ New Workflow list ") + theme.fg("accent", `"${snap.listTitle}"`);
					if (snap.listDescription) msg += theme.fg("dim", ` — ${snap.listDescription}`);
					return new Text(msg, 0, 0);
				}

				case "list": {
					if (taskList.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);

					const total = taskList.length;
					const closed = taskList.filter((t) => isClosedStatus(t.status)).length;
					const pct = Math.round((closed / total) * 100);

					let listText = snap.listTitle ? theme.fg("accent", snap.listTitle) + theme.fg("dim", "  ") : "";
					listText += theme.fg("dim", `${pct}% [${progressBar(pct)}] · ${closed}/${total} closed`);

					const display = expanded ? taskList : taskList.slice(0, 5);
					for (const t of display) {
						const icon =
							t.status === "done"
								? theme.fg("success", STATUS_ICON.done)
								: t.status === "inprogress"
									? theme.fg("accent", STATUS_ICON.inprogress)
									: t.status === "blocked"
										? theme.fg("error", STATUS_ICON.blocked)
										: t.status === "skipped"
											? theme.fg("dim", STATUS_ICON.skipped)
											: theme.fg("dim", STATUS_ICON.idle);
						const itemText =
							t.status === "done"
								? theme.fg("dim", t.text)
								: t.status === "inprogress"
									? theme.fg("success", t.text)
									: t.status === "blocked"
										? theme.fg("warning", t.text)
										: theme.fg("muted", t.text);
						const imp = t.importance !== "normal" ? theme.fg("dim", ` [${t.importance}]`) : "";
						listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)}${imp} ${itemText}`;
						if (t.status === "blocked" && t.blockedReason) {
							listText += `\n  ${theme.fg("error", `blocked: ${t.blockedReason}`)}`;
						}
					}
					if (!expanded && taskList.length > 5) {
						listText += `\n${theme.fg("dim", `  … ${taskList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", firstLine), 0, 0);

				case "start":
					return new Text(theme.fg("accent", "▶ ") + theme.fg("success", firstLine), 0, 0);

				case "done":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", firstLine), 0, 0);

				case "pause":
					return new Text(theme.fg("warning", "⏸ ") + theme.fg("muted", firstLine), 0, 0);

				case "block":
					return new Text(theme.fg("error", "■ ") + theme.fg("warning", firstLine), 0, 0);

				case "unblock":
					return new Text(theme.fg("success", "○ ") + theme.fg("muted", firstLine), 0, 0);

				case "skip":
					return new Text(theme.fg("dim", "↷ ") + theme.fg("dim", firstLine), 0, 0);

				case "remove":
					return new Text(theme.fg("warning", "✕ ") + theme.fg("muted", firstLine), 0, 0);

				case "update":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", firstLine), 0, 0);

				case "move":
					return new Text(theme.fg("accent", "↕ ") + theme.fg("muted", firstLine), 0, 0);

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared Workflow list"), 0, 0);

				default:
					return new Text(theme.fg("dim", firstLine || "done"), 0, 0);
			}
		},
	});

	// ── /workflow slash command ────────────────────────────────────────────────

	pi.registerCommand("workflow", {
		description: "Open the current Workflow task list",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/workflow requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				overlayTui = tui;
				const component = new WorkflowListComponent(
					() => tasks,
					() => listTitle,
					() => listDescription,
					theme,
					() => {
						overlayTui = undefined;
						done();
					},
					() => stateVersion,
				);
				return component;
			});
			overlayTui = undefined;
		},
	});
}
