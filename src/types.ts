/**
 * Structural mirror of the subset of Pi's `AgentMessage` the serializer touches.
 *
 * Deliberately dependency-free: the serializer is the algorithm, and it should be
 * unit-testable against plain JSON without a Pi runtime. Shapes follow
 * docs/message-types.md. Unknown roles and block types are tolerated rather than
 * rejected, because Pi's union is extensible (declaration merging) and a panic
 * here would mean a failed compaction.
 */

export interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface ThinkingBlock {
	readonly type: "thinking";
	readonly thinking: string;
	/** Provider replay data. Opaque, and never carried into a digest. */
	readonly thinkingSignature?: string;
	readonly redacted?: boolean;
}

export interface ImageBlock {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface ToolCallBlock {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface UnknownBlock {
	readonly type: string;
	readonly [key: string]: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolCallBlock | UnknownBlock;
export type Content = string | readonly ContentBlock[];

export interface SystemMsg {
	readonly role: "system";
	readonly content: Content;
	readonly timestamp?: number;
}

export interface UserMsg {
	readonly role: "user";
	readonly content: Content;
	readonly timestamp?: number;
}

export interface AssistantMsg {
	readonly role: "assistant";
	readonly content: readonly ContentBlock[];
	readonly timestamp?: number;
}

export interface ToolResultMsg {
	readonly role: "toolResult";
	readonly content: readonly ContentBlock[];
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
	/** Tool-specific metadata, e.g. BashToolDetails.fullOutputPath. */
	readonly details?: Record<string, unknown>;
	readonly timestamp?: number;
}

/** Direct shell execution (not an LLM tool result). */
export interface BashExecutionMsg {
	readonly role: "bashExecution";
	readonly command: string;
	readonly output: string;
	readonly exitCode?: number;
	readonly cancelled?: boolean;
	readonly truncated?: boolean;
	readonly fullOutputPath?: string;
	readonly excludeFromContext?: boolean;
	readonly timestamp?: number;
}

/** Extension-injected context message. */
export interface CustomMsg {
	readonly role: "custom";
	readonly customType: string;
	readonly content: Content;
	readonly display?: boolean;
	readonly timestamp?: number;
}

/** Carries context from an abandoned branch; the only carrier of it. */
export interface BranchSummaryMsg {
	readonly role: "branchSummary";
	readonly summary: string;
	readonly fromId?: string | null;
	readonly timestamp?: number;
}

/** A prior compaction. Dropped, never folded forward. */
export interface CompactionSummaryMsg {
	readonly role: "compactionSummary";
	readonly summary: string;
	readonly tokensBefore: number;
	readonly timestamp?: number;
}

export type AgentMsg =
	| SystemMsg
	| UserMsg
	| AssistantMsg
	| ToolResultMsg
	| BashExecutionMsg
	| CustomMsg
	| BranchSummaryMsg
	| CompactionSummaryMsg;

/** Tolerated escape hatch for roles added by declaration merging. */
export interface UnknownMsg {
	readonly role: string;
	readonly content?: Content;
	readonly [key: string]: unknown;
}

export type AnyMsg = AgentMsg | UnknownMsg;

// --- accessors --------------------------------------------------------------

export function contentBlocks(content: Content | undefined): readonly ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

export function isToolResult(m: AnyMsg): m is ToolResultMsg {
	return m.role === "toolResult";
}

export function isAssistant(m: AnyMsg): m is AssistantMsg {
	return m.role === "assistant";
}

export function isUser(m: AnyMsg): m is UserMsg {
	return m.role === "user";
}

/** Blocks a text-only view can render. Unknown block types are ignored. */
export function textOf(content: Content | undefined): string {
	const parts: string[] = [];
	for (const b of contentBlocks(content)) {
		if (b.type === "text" && typeof (b as TextBlock).text === "string") {
			parts.push((b as TextBlock).text);
		}
	}
	return parts.join("\n");
}

/** Result text of a tool result, across `content` shapes. */
export function toolResultText(m: AnyMsg): string {
	if (isToolResult(m)) return textOf(m.content);
	return textOf((m as { content?: Content }).content);
}
