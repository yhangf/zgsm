import * as path from "path"
import os from "os"
import crypto from "crypto"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"

// schemas
import { TokenUsage, ToolUsage, ToolName, ContextCondense } from "../../schemas"
import { isLanguage } from "../../schemas"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream } from "../../api/transform/stream"

// shared
import { ProviderSettings } from "../../shared/api"
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import {
	ClineApiReqCancelReason,
	ClineApiReqInfo,
	ClineAsk,
	ClineMessage,
	ClineSay,
	ToolProgressStatus,
} from "../../shared/ExtensionMessage"
import { getApiMetrics } from "../../shared/getApiMetrics"
import { HistoryItem } from "../../shared/HistoryItem"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { LANGUAGES } from "../../shared/language"

// services
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher"
import { BrowserSession } from "../../services/browser/BrowserSession"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { telemetryService } from "../../services/telemetry/TelemetryService"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName, formatContentBlockToMarkdown } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { TelemetryService } from "../../services/telemetry"

// utils
import { calculateApiCostAnthropic } from "../../utils/cost"
import { getWorkspacePath } from "../../utils/path"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { type AssistantMessageContent, parseAssistantMessage, presentAssistantMessage } from "../assistant-message"
import { truncateConversationIfNeeded } from "../sliding-window"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { readApiMessages, saveApiMessages, readTaskMessages, saveTaskMessages, taskMetadata } from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { ApiMessage } from "../task-persistence/apiMessages"
import { getMessagesSinceLastSummary, summarizeConversation } from "../condense"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { t } from "../../i18n"
import { parseJwt } from "../../utils/jwt"
import { getShell } from "../../utils/shell"

export type ClineEvents = {
	message: [{ action: "created" | "updated"; message: ClineMessage }]
	taskStarted: []
	taskModeSwitched: [taskId: string, mode: string]
	taskPaused: []
	taskUnpaused: []
	taskAskResponded: []
	taskAborted: []
	taskSpawned: [taskId: string]
	taskCompleted: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	taskTokenUsageUpdated: [taskId: string, tokenUsage: TokenUsage]
	taskToolFailed: [taskId: string, tool: ToolName, error: string]
}

export type TaskOptions = {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableDiff?: boolean
	enableCheckpoints?: boolean
	fuzzyMatchThreshold?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (cline: Task) => void
}

export class Task extends EventEmitter<ClineEvents> {
	readonly taskId: string
	readonly instanceId: string

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false
	didFinishAbortingStream = false
	abandoned = false
	isInitialized = false
	isPaused: boolean = false
	pausedModeSlug: string = defaultModeSlug
	private pauseInterval: NodeJS.Timeout | undefined

	// API
	readonly apiConfiguration: ProviderSettings
	api: ApiHandler & {
		setTaskId?: (taskId: string) => void
		setChatType?: (type: "user" | "system") => void
		getChatType?: () => "user" | "system"
	}
	private lastApiRequestTime?: number
	private consecutiveAutoApprovedRequestsCount: number = 0

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	fileContextTracker: FileContextTracker
	urlContentFetcher: UrlContentFetcher
	terminalProcess?: RooTerminalProcess

	// Computer User
	browserSession: BrowserSession

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	diffEnabled: boolean = false
	fuzzyMatchThreshold: number
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	toolUsage: ToolUsage = {}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
	userMessageContentReady = false
	didRejectTool = false
	didAlreadyUseTool = false
	didCompleteReadingStream = false

	constructor({
		provider,
		apiConfiguration,
		enableDiff = false,
		enableCheckpoints = true,
		fuzzyMatchThreshold = 1.0,
		consecutiveMistakeLimit = 3,
		task,
		images,
		historyItem,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.taskId = historyItem ? historyItem.id : crypto.randomUUID()
		// normal use-case is usually retry similar history task with new workspace
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: getWorkspacePath(path.join(os.homedir(), "Desktop"))
		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(apiConfiguration)

		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context)
		this.diffEnabled = enableDiff
		this.fuzzyMatchThreshold = fuzzyMatchThreshold
		this.consecutiveMistakeLimit = consecutiveMistakeLimit
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd)
		this.enableCheckpoints = enableCheckpoints

		this.rootTask = rootTask
		this.parentTask = parentTask
		this.taskNumber = taskNumber

		if (historyItem) {
			telemetryService.captureTaskRestarted(this.taskId)
		} else {
			telemetryService.captureTaskCreated(this.taskId)
		}

		this.diffStrategy = new MultiSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)
		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		onCreated?.(this)

		if (startTask) {
			if (task || images) {
				this.api?.setChatType?.("user")
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			instance.api?.setChatType?.("user")
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		const messageWithTs = { ...message, ts: Date.now() }
		this.apiConversationHistory.push(messageWithTs)
		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			await saveApiMessages({
				messages: this.apiConversationHistory,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
		} catch (error) {
			// In the off chance this fails, we don't want to stop the task.
			console.error("Failed to save API conversation history:", error)
		}
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		await this.providerRef.deref()?.postStateToWebview()
		this.emit("message", { action: "created", message })
		await this.saveClineMessages()
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		await this.saveClineMessages()
	}

	private async updateClineMessage(partialMessage: ClineMessage) {
		await this.providerRef.deref()?.postMessageToWebview({ type: "partialMessage", partialMessage })
		this.emit("message", { action: "updated", message: partialMessage })
	}

	private async saveClineMessages() {
		try {
			await saveTaskMessages({
				messages: this.clineMessages,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			const { historyItem, tokenUsage } = await taskMetadata({
				messages: this.clineMessages,
				taskId: this.taskId,
				taskNumber: this.taskNumber,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
			})

			this.emit("taskTokenUsageUpdated", this.taskId, tokenUsage)

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
		} catch (error) {
			console.error("Failed to save Costrict messages:", error)
		}
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[Costrict#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					throw new Error("Current ask promise was ignored (#1)")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial })
					throw new Error("Current ask promise was ignored (#2)")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text })
		}

		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new Error("Current ask promise was ignored")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.emit("taskAskResponded")
		return result
	}

	async handleWebviewAskResponse(
		askResponse: ClineAskResponse,
		text?: string,
		images?: string[],
		chatType?: "system" | "user",
	) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
		this.api.setChatType?.(chatType || "system")
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	public async condenseContext(): Promise<void> {
		const systemPrompt = await this.getSystemPrompt()
		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
		} = await summarizeConversation(this.apiConversationHistory, this.api, systemPrompt, this.taskId)
		if (!summary) {
			return
		}
		await this.overwriteApiConversationHistory(messages)
		const { contextTokens } = this.getTokenUsage()
		const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens: contextTokens }
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[Costrict#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images, contextCondense })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Costrict tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Start / Abort / Resume

	private async startTask(task?: string, images?: string[]): Promise<void> {
		// `conversationHistory` (for API) and `clineMessages` (for webview)
		// need to be in sync.
		// If the extension process were killed, then on restart the
		// `clineMessages` might not be empty, so we need to set it to [] when
		// we create a new Cline client (otherwise webview would show stale
		// messages from previous session).
		this.clineMessages = []
		this.apiConversationHistory = []
		await this.providerRef.deref()?.postStateToWebview()

		await this.say("text", task, images)
		this.isInitialized = true

		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

		console.log(`[subtasks] task ${this.taskId}.${this.instanceId} starting`)

		await this.initiateTaskLoop([
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		])
	}

	public async resumePausedTask(lastMessage: string) {
		// Release this Cline instance from paused state.
		this.isPaused = false
		this.emit("taskUnpaused")

		// Fake an answer from the subtask that it has completed running and
		// this is the result of what it has done  add the message to the chat
		// history and to the webview ui.
		try {
			await this.say("subtask_result", lastMessage)

			await this.addToApiConversationHistory({
				role: "user",
				content: [{ type: "text", text: `[new_task completed] Result: ${lastMessage}` }],
			})
		} catch (error) {
			this.providerRef
				.deref()
				?.log(`Error failed to add reply from subtask into conversation of parent task, error: ${error}`)

			throw error
		}
	}

	private async resumeTaskFromHistory() {
		const modifiedClineMessages = await this.getSavedClineMessages()

		// Remove any resume messages that may have been added before
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// since we don't use api_req_finished anymore, we need to check if the last api_req_started has a cost value, if it doesn't and no cancellation reason to present, then we remove it since it indicates an api request without any partial content streamed
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		this.apiConversationHistory = await this.getSavedApiConversationHistory()

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // could be multiple resume tasks

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		const { response, text, images } = await this.ask(askType) // calls poststatetowebview
		let responseText: string | undefined
		let responseImages: string[] | undefined
		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

		// v2.0 xml tags refactor caveat: since we don't use tools anymore, we need to replace all tool use blocks with a text block since the API disallows conversations with tool uses and no tool schema
		const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
			if (Array.isArray(message.content)) {
				const newContent = message.content.map((block) => {
					if (block.type === "tool_use") {
						// it's important we convert to the new tool schema format so the model doesn't get confused about how to invoke tools
						const inputAsXml = Object.entries(block.input as Record<string, string>)
							.map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
							.join("\n")
						return {
							type: "text",
							text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
						} as Anthropic.Messages.TextBlockParam
					} else if (block.type === "tool_result") {
						// Convert block.content to text block array, removing images
						const contentAsTextBlocks = Array.isArray(block.content)
							? block.content.filter((item) => item.type === "text")
							: [{ type: "text", text: block.content }]
						const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n")
						const toolName = findToolName(block.tool_use_id, existingApiConversationHistory)
						return {
							type: "text",
							text: `[${toolName} Result]\n\n${textContent}`,
						} as Anthropic.Messages.TextBlockParam
					}
					return block
				})
				return { ...message, content: newContent }
			}
			return message
		})
		existingApiConversationHistory = conversationWithoutToolBlocks

		// FIXME: remove tool use blocks altogether

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: ApiMessage | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id),
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

		const agoText = ((): string => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		const lastTaskResumptionIndex = newUserContent.findIndex(
			(x) => x.type === "text" && x.text.startsWith("[TASK RESUMPTION]"),
		)
		if (lastTaskResumptionIndex !== -1) {
			newUserContent.splice(lastTaskResumptionIndex, newUserContent.length - lastTaskResumptionIndex)
		}

		const wasRecent = lastClineMessage?.ts && Date.now() - lastClineMessage.ts < 30_000

		newUserContent.push({
			type: "text",
			text:
				`[TASK RESUMPTION] This task was interrupted ${agoText}. It may or may not be complete, so please reassess the task context. Be aware that the project state may have changed since then. If the task has not been completed, retry the last step before interruption and proceed with completing the task.\n\nNote: If you previously attempted a tool use that the user did not provide a result for, you should assume the tool use was not successful and assess whether you should retry. If the last tool was a browser_action, the browser has been closed and you must launch a new browser if needed.${
					wasRecent
						? "\n\nIMPORTANT: If the last tool use was a write_to_file that was interrupted, the file was reverted back to its original state before the interrupted edit, and you do NOT need to re-read the file as you already have its up-to-date contents."
						: ""
				}` +
				(responseText
					? `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`
					: ""),
		})

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

		console.log(`[subtasks] task ${this.taskId}.${this.instanceId} resuming from history item`)

		await this.initiateTaskLoop(newUserContent)
	}

	public async abortTask(isAbandoned = false) {
		console.log(`[subtasks] aborting task ${this.taskId}.${this.instanceId}`)

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.emit("taskAborted")

		// Stop waiting for child task completion.
		if (this.pauseInterval) {
			clearInterval(this.pauseInterval)
			this.pauseInterval = undefined
		}

		// Release any terminals associated with this task.
		TerminalRegistry.releaseTerminalsForTask(this.taskId)

		this.urlContentFetcher.closeBrowser()
		this.browserSession.closeBrowser()
		this.rooIgnoreController?.dispose()
		this.fileContextTracker.dispose()

		// If we're not streaming then `abortStream` (which reverts the diff
		// view changes) won't be called, so we need to revert the changes here.
		if (this.isStreaming && this.diffViewProvider.isEditing) {
			await this.diffViewProvider.revertChanges()
		}

		// Save the countdown message in the automatic retry or other content.
		await this.saveClineMessages()
	}

	// Used when a sub-task is launched and the parent task is waiting for it to
	// finish.
	// TBD: The 1s should be added to the settings, also should add a timeout to
	// prevent infinite waiting.
	public async waitForResume() {
		await new Promise<void>((resolve) => {
			this.pauseInterval = setInterval(() => {
				if (!this.isPaused) {
					clearInterval(this.pauseInterval)
					this.pauseInterval = undefined
					resolve()
				}
			}, 1000)
		})
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit("taskStarted")

		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // we only need file details the first time

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
				this.consecutiveMistakeCount++
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		if (this.abort) {
			throw new Error(`[Costrict#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
			const { response, text, images } = await this.ask(
				"mistake_limit_reached",
				this.api.getModel().id.includes("claude")
					? `This may indicate a failure in his thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
					: "Costrict uses complex prompts and iterative task execution that may be challenging for less capable models. For best results, it's recommended to use Claude 3.7 Sonnet for its advanced agentic coding capabilities.",
			)

			if (response === "messageResponse") {
				userContent.push(
					...[
						{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
						...formatResponse.imageBlocks(images),
					],
				)

				await this.say("user_feedback", text, images)

				// Track consecutive mistake errors in telemetry.
				telemetryService.captureConsecutiveMistakeError(this.taskId)
			}

			this.consecutiveMistakeCount = 0
		}

		// In this Cline request loop, we need to check if this task instance
		// has been asked to wait for a subtask to finish before continuing.
		const provider = this.providerRef.deref()

		if (this.isPaused && provider) {
			provider.log(`[subtasks] paused ${this.taskId}.${this.instanceId}`)
			await this.waitForResume()
			provider.log(`[subtasks] resumed ${this.taskId}.${this.instanceId}`)
			const currentMode = (await provider.getState())?.mode ?? defaultModeSlug

			if (currentMode !== this.pausedModeSlug) {
				// The mode has changed, we need to switch back to the paused mode.
				await provider.handleModeSwitch(this.pausedModeSlug)

				// Delay to allow mode change to take effect before next tool is executed.
				await delay(500)

				provider.log(
					`[subtasks] task ${this.taskId}.${this.instanceId} has switched back to '${this.pausedModeSlug}' from '${currentMode}'`,
				)
			}
		}

		// Getting verbose details is an expensive operation, it uses ripgrep to
		// top-down build file structure of project which for large projects can
		// take a few seconds. For the best UX we show a placeholder api_req_started
		// message with a loading spinner as this happens.
		await this.say(
			"api_req_started",
			JSON.stringify({
				request:
					userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
			}),
		)

		const parsedUserContent = await processUserContentMentions({
			userContent,
			cwd: this.cwd,
			urlContentFetcher: this.urlContentFetcher,
			fileContextTracker: this.fileContextTracker,
			cline: this,
		})

		const environmentDetails = await getEnvironmentDetails(this, includeFileDetails)

		// Add environment details as its own text block, separate from tool
		// results.
		const finalUserContent = [...parsedUserContent, { type: "text" as const, text: environmentDetails }]

		// Add language preference to user content if available
		const { language } = (await this.providerRef.deref()?.getState()) ?? {}
		if (language) {
			const languageName = isLanguage(language) ? LANGUAGES[language] : language
			await this.addToApiConversationHistory({
				role: "user",
				content: `\nPlease also follow these instructions in all of your responses if relevant to my query. No need to acknowledge these instructions directly in your response.\n\nAlways respond in ${languageName}\nYou must use a tool in your response! \n# Reminder: Instructions for Tool Use\n\nTool uses are formatted using XML-style tags. The tool name is enclosed in opening and closing tags, and each parameter is similarly enclosed within its own set of tags. Here's the structure:\n\n<tool_name>\n<parameter1_name>value1</parameter1_name>\n<parameter2_name>value2</parameter2_name>\n...\n</tool_name>\n\nFor example:\n\n<attempt_completion>\n<result>\nI have completed the task...\n</result>\n</attempt_completion>\n\nAlways adhere to this format for all tool uses to ensure proper parsing and execution.\n\n# Next Steps\n\nIf you have completed the user's task, use the attempt_completion tool. \nIf you require additional information from the user, use the ask_followup_question tool. \nOtherwise, if you have not completed the task and do not need additional information, then proceed with the next step of the task.\nWhen creating multiple folders using the command, please use mkidr - p path1; mkdir -p path2.\n(This is an automated message, so do not respond to it conversationally.)`,
			})
		}
		await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
		telemetryService.captureConversationMessage(this.taskId, "user")

		// Since we sent off a placeholder api_req_started message to update the
		// webview while waiting to actually start the API request (to load
		// potential details for example), we need to update the text of that
		// message.
		const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

		this.clineMessages[lastApiReqIndex].text = JSON.stringify({
			request: finalUserContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
		} satisfies ClineApiReqInfo)

		await this.saveClineMessages()
		await provider?.postStateToWebview()

		try {
			let cacheWriteTokens = 0
			let cacheReadTokens = 0
			let inputTokens = 0
			let outputTokens = 0
			let totalCost: number | undefined

			// We can't use `api_req_finished` anymore since it's a unique case
			// where it could come after a streaming message (i.e. in the middle
			// of being updated or executed).
			// Fortunately `api_req_finished` was always parsed out for the GUI
			// anyways, so it remains solely for legacy purposes to keep track
			// of prices in tasks from history (it's worth removing a few months
			// from now).
			const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				this.clineMessages[lastApiReqIndex].text = JSON.stringify({
					...JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}"),
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheWriteTokens,
					cacheReads: cacheReadTokens,
					cost:
						totalCost ??
						calculateApiCostAnthropic(
							this.api.getModel().info,
							inputTokens,
							outputTokens,
							cacheWriteTokens,
							cacheReadTokens,
						),
					cancelReason,
					streamingFailedMessage,
				} satisfies ClineApiReqInfo)
			}

			const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // closes diff view
				}

				// if last message is a partial we need to update and save it
				const lastMessage = this.clineMessages.at(-1)

				if (lastMessage && lastMessage.partial) {
					// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
					lastMessage.partial = false
					// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					console.log("updating partial message", lastMessage)
					// await this.saveClineMessages()
				}

				// Let assistant know their response was interrupted for when task is resumed
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
				})

				// Update `api_req_started` to have cancelled and cost, so that
				// we can display the cost of the partial stream.
				updateApiReqMsg(cancelReason, streamingFailedMessage)
				await this.saveClineMessages()

				// Signals to provider that it can retrieve the saved messages
				// from disk, as abortTask can not be awaited on in nature.
				this.didFinishAbortingStream = true
			}

			// Reset streaming state.
			this.currentStreamingContentIndex = 0
			this.assistantMessageContent = []
			this.didCompleteReadingStream = false
			this.userMessageContent = []
			this.userMessageContentReady = false
			this.didRejectTool = false
			this.didAlreadyUseTool = false
			this.presentAssistantMessageLocked = false
			this.presentAssistantMessageHasPendingUpdates = false

			await this.diffViewProvider.reset()
			// Yields only if the first chunk is successful, otherwise will
			// allow the user to retry the request (most likely due to rate
			// limit error, which gets thrown on the first chunk).
			const stream = this.attemptApiRequest()
			let assistantMessage = ""
			let reasoningMessage = ""
			this.isStreaming = true

			try {
				for await (const chunk of stream) {
					this.api?.setChatType?.("system")

					if (!chunk) {
						// Sometimes chunk is undefined, no idea that can cause
						// it, but this workaround seems to fix it.
						continue
					}

					switch (chunk.type) {
						case "reasoning":
							reasoningMessage += chunk.text
							await this.say("reasoning", reasoningMessage, undefined, true)
							break
						case "usage":
							inputTokens += chunk.inputTokens
							outputTokens += chunk.outputTokens
							cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							cacheReadTokens += chunk.cacheReadTokens ?? 0
							totalCost = chunk.totalCost
							break
						case "text":
							assistantMessage += chunk.text

							// Parse raw assistant message into content blocks.
							const prevLength = this.assistantMessageContent.length
							this.assistantMessageContent = parseAssistantMessage(assistantMessage)

							if (this.assistantMessageContent.length > prevLength) {
								// New content we need to present, reset to
								// false in case previous content set this to true.
								this.userMessageContentReady = false
							}

							// Present content to user.
							presentAssistantMessage(this)
							break
					}

					if (this.abort) {
						console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

						if (!this.abandoned) {
							// Only need to gracefully abort if this instance
							// isn't abandoned (sometimes OpenRouter stream
							// hangs, in which case this would affect future
							// instances of Cline).
							await abortStream("user_cancelled")
						}

						break // Aborts the stream.
					}

					if (this.didRejectTool) {
						// `userContent` has a tool rejection, so interrupt the
						// assistant's response to present the user's feedback.
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						// Instead of setting this premptively, we allow the
						// present iterator to finish and set
						// userMessageContentReady when its ready.
						// this.userMessageContentReady = true
						break
					}

					// PREV: We need to let the request finish for openrouter to
					// get generation details.
					// UPDATE: It's better UX to interrupt the request at the
					// cost of the API cost not being retrieved.
					if (this.didAlreadyUseTool) {
						assistantMessage +=
							"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						break
					}
				}
			} catch (error) {
				// Abandoned happens when extension is no longer waiting for the
				// Cline instance to finish aborting (error is thrown here when
				// any function in the for loop throws due to this.abort).
				if (!this.abandoned) {
					// If the stream failed, there's various states the task
					// could be in (i.e. could have streamed some tools the user
					// may have executed), so we just resort to replicating a
					// cancel task.
					this.abortTask()

					await abortStream(
						"streaming_failed",
						error.message ?? JSON.stringify(serializeError(error), null, 2),
					)

					const history = await provider?.getTaskWithId(this.taskId)

					if (history) {
						await provider?.initClineWithHistoryItem(history.historyItem)
					}
				}
			} finally {
				this.isStreaming = false
			}

			// Need to call here in case the stream was aborted.
			if (this.abort || this.abandoned) {
				throw new Error(`[Costrict#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			this.didCompleteReadingStream = true

			// Set any blocks to be complete to allow `presentAssistantMessage`
			// to finish and set `userMessageContentReady` to true.
			// (Could be a text block that had no subsequent tool uses, or a
			// text block at the very end, or an invalid tool use, etc. Whatever
			// the case, `presentAssistantMessage` relies on these blocks either
			// to be completed or the user to reject a block in order to proceed
			// and eventually set userMessageContentReady to true.)
			const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => (block.partial = false))

			// Can't just do this b/c a tool could be in the middle of executing.
			// this.assistantMessageContent.forEach((e) => (e.partial = false))

			if (partialBlocks.length > 0) {
				// If there is content to update then it will complete and
				// update `this.userMessageContentReady` to true, which we
				// `pWaitFor` before making the next request. All this is really
				// doing is presenting the last partial message that we just set
				// to complete.
				presentAssistantMessage(this)
			}

			updateApiReqMsg()
			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebview()

			// Now add to apiConversationHistory.
			// Need to save assistant responses to file before proceeding to
			// tool use since user can exit at any moment and we wouldn't be
			// able to save the assistant's response.
			let didEndLoop = false

			if (assistantMessage.length > 0) {
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: assistantMessage }],
				})

				telemetryService.captureConversationMessage(this.taskId, "assistant")

				// NOTE: This comment is here for future reference - this was a
				// workaround for `userMessageContent` not getting set to true.
				// It was due to it not recursively calling for partial blocks
				// when `didRejectTool`, so it would get stuck waiting for a
				// partial block to complete before it could continue.
				// In case the content blocks finished it may be the api stream
				// finished after the last parsed content block was executed, so
				// we are able to detect out of bounds and set
				// `userMessageContentReady` to true (note you should not call
				// `presentAssistantMessage` since if the last block i
				//  completed it will be presented again).
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				await pWaitFor(() => this.userMessageContentReady)

				// If the model did not tool use, then we need to tell it to
				// either use a tool or attempt_completion.
				const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse) {
					this.userMessageContent.push({ type: "text", text: formatResponse.noToolsUsed() })
					this.consecutiveMistakeCount++
				}

				const recDidEndLoop = await this.recursivelyMakeClineRequests(this.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				// If there's no assistant_responses, that means we got no text
				// or tool_use content blocks from API which we should assume is
				// an error.
				await this.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
				)

				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not provide a response." }],
				})
			}

			return didEndLoop // Will always be false for now.
		} catch (error) {
			// This should never happen since the only thing that can throw an
			// error is the attemptApiRequest, which is wrapped in a try catch
			// that sends an ask where if noButtonClicked, will clear current
			// task and destroy this instance. However to avoid unhandled
			// promise rejection, we will end this loop which will end execution
			// of this instance (see `startTask`).
			return true // Needs to be true so parent loop knows to end task.
		}
	}

	private async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const {
			browserViewportSize,
			mode,
			customModePrompts,
			customInstructions,
			experiments,
			enableMcpServerCreation,
			browserToolEnabled,
			language,
		} = (await this.providerRef.deref()?.getState()) ?? {}

		const { customModes } = (await this.providerRef.deref()?.getState()) ?? {}

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			const shellSuggestion =
				process.env.NODE_ENV === "test"
					? ""
					: `\nThe user's current shell is \`${getShell()}\`, and all command outputs must adhere to the syntax.\n`

			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				(this.api.getModel().info.supportsComputerUse ?? false) && (browserToolEnabled ?? true),
				mcpHub,
				this.diffStrategy,
				browserViewportSize,
				mode,
				customModePrompts,
				customModes,
				shellSuggestion + customInstructions,
				this.diffEnabled,
				experiments,
				enableMcpServerCreation,
				language,
				rooIgnoreInstructions,
			)
		})()
	}

	public async *attemptApiRequest(retryAttempt: number = 0): ApiStream {
		const {
			mode,
			apiConfiguration,
			autoApprovalEnabled,
			alwaysApproveResubmit,
			requestDelaySeconds,
			experiments,
			autoCondenseContextPercent = 100,
		} = (await this.providerRef.deref()?.getState()) ?? {}

		let rateLimitDelay = 0
		// Only apply rate limiting if this isn't the first request
		if (this.lastApiRequestTime) {
			const now = Date.now()
			const timeSinceLastRequest = now - this.lastApiRequestTime
			const rateLimit = apiConfiguration?.rateLimitSeconds || 0
			rateLimitDelay = Math.ceil(Math.max(0, rateLimit * 1000 - timeSinceLastRequest) / 1000)
		}

		// Only show rate limiting message if we're not retrying. If retrying, we'll include the delay there.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			// Show countdown timer
			for (let i = rateLimitDelay; i > 0; i--) {
				const delayMessage = `Rate limiting for ${i} seconds...`
				await this.say("api_req_retry_delayed", delayMessage, undefined, true)
				await delay(1000)
			}
		}

		// Update last request time before making the request
		this.lastApiRequestTime = Date.now()

		const systemPrompt = await this.getSystemPrompt()

		const { contextTokens } = this.getTokenUsage()
		if (contextTokens) {
			// Default max tokens value for thinking models when no specific
			// value is set.
			const DEFAULT_THINKING_MODEL_MAX_TOKENS = 16_384

			const modelInfo = this.api.getModel().info

			const maxTokens = modelInfo.thinking
				? this.apiConfiguration.modelMaxTokens || DEFAULT_THINKING_MODEL_MAX_TOKENS
				: modelInfo.maxTokens

			const contextWindow = modelInfo.contextWindow

			const autoCondenseContext = experiments?.autoCondenseContext ?? false
			const truncateResult = await truncateConversationIfNeeded({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext,
				autoCondenseContextPercent,
				systemPrompt,
				taskId: this.taskId,
			})
			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}
			if (truncateResult.summary) {
				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			}
		}

		const messagesSinceLastSummary = getMessagesSinceLastSummary(this.apiConversationHistory)
		const cleanConversationHistory = maybeRemoveImageBlocks(messagesSinceLastSummary, this.api).map(
			({ role, content }) => ({ role, content }),
		)

		// Check if we've reached the maximum number of auto-approved requests
		const { allowedMaxRequests, language } = (await this.providerRef.deref()?.getState()) ?? {}
		const maxRequests = allowedMaxRequests || Infinity

		// Increment the counter for each new API request
		this.consecutiveAutoApprovedRequestsCount++

		if (this.consecutiveAutoApprovedRequestsCount > maxRequests) {
			const { response } = await this.ask("auto_approval_max_req_reached", JSON.stringify({ count: maxRequests }))
			// If we get past the promise, it means the user approved and did not start a new task
			if (response === "yesButtonClicked") {
				this.consecutiveAutoApprovedRequestsCount = 0
			}
		}
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.taskId,
			language,
			instanceId: this.instanceId,
		}
		const stream = this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)
		const iterator = stream[Symbol.asyncIterator]()

		try {
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			this.isWaitingForFirstChunk = false
			const errorMsg = await this.getTaskRequestError(error, this.taskId, this.instanceId, this.apiConfiguration)
			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (autoApprovalEnabled && alwaysApproveResubmit) {
				const baseDelay = requestDelaySeconds || 5
				let exponentialDelay = Math.ceil(baseDelay * Math.pow(2, retryAttempt))

				// If the error is a 429, and the error details contain a retry delay, use that delay instead of exponential backoff
				if (error.status === 429) {
					const geminiRetryDetails = error.errorDetails?.find(
						(detail: any) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
					)
					if (geminiRetryDetails) {
						const match = geminiRetryDetails?.retryDelay?.match(/^(\d+)s$/)
						if (match) {
							exponentialDelay = Number(match[1]) + 1
						}
					}
				}

				// Wait for the greater of the exponential delay or the rate limit delay
				const finalDelay = Math.max(exponentialDelay, rateLimitDelay)

				// Show countdown timer with exponential backoff
				for (let i = finalDelay; i > 0; i--) {
					await this.say(
						"api_req_retry_delayed",
						`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying in ${i} seconds...`,
						undefined,
						true,
					)
					await delay(1000)
				}

				await this.say(
					"api_req_retry_delayed",
					`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying now...`,
					undefined,
					false,
				)

				// Delegate generator output from the recursive call with
				// incremented retry count.
				this.api?.setChatType?.("system")
				yield* this.attemptApiRequest(retryAttempt + 1)

				return
			} else {
				const { response } = await this.ask("api_req_failed", errorMsg)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				await this.say("api_req_retried")

				// Delegate generator output from the recursive call.
				this.api?.setChatType?.("system")
				yield* this.attemptApiRequest()
				return
			}
		}

		// No error, so we can continue to yield all remaining chunks.
		// (Needs to be placed outside of try/catch since it we want caller to
		// handle errors not with api_req_failed as that is reserved for first
		// chunk failures only.)
		// This delegates to another generator or iterable object. In this case,
		// it's saying "yield all remaining values from this iterator". This
		// effectively passes along all subsequent chunks from the original
		// stream.
		yield* iterator
	}

	// Checkpoints

	public async checkpointSave() {
		return checkpointSave(this)
	}

	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	public async getTaskRequestError(
		error: any,
		taskId: string,
		instanceId: string,
		apiConfiguration: ProviderSettings,
	) {
		const isHtml = error?.headers && error.headers["content-type"].includes("text/")
		let rawError = error.error?.metadata?.raw ? JSON.stringify(error.error.metadata.raw, null, 2) : error.message
		let status = error.status
		const unknownError = { status: t("apiErrors:status.unknown"), solution: t("apiErrors:solution.unknown") }
		let jsonBody = rawError.split(", response body: {")[1] || ""
		jsonBody = jsonBody ? `{${jsonBody}` : ""
		if (!jsonBody && typeof this.zgsmParse(error.message, error.message) === "object") {
			jsonBody = error.message
		}
		let zgsmApiKeyExpiredAt = ""
		let zgsmApiKeyUpdatedAt = ""
		let isOldModeLoginState = false
		if (apiConfiguration.zgsmApiKey) {
			const { exp, iat, universal_id } = parseJwt(apiConfiguration.zgsmApiKey)
			zgsmApiKeyExpiredAt = new Date(exp * 1000).toLocaleString()
			zgsmApiKeyUpdatedAt = new Date(iat * 1000).toLocaleString()
			isOldModeLoginState = !universal_id
		}

		const defaultApiErrors = {
			401: {
				status: isOldModeLoginState
					? t("apiErrors:status.old_mode_token")
					: t("apiErrors:status.401", {
							exp: zgsmApiKeyExpiredAt || "-",
							iat: zgsmApiKeyUpdatedAt || "-",
						}),
				solution: t("apiErrors:solution.401"),
			},
			400: { status: rawError || t("apiErrors:status.400"), solution: t("apiErrors:solution.400") },
			403: { status: rawError || t("apiErrors:status.403"), solution: t("apiErrors:solution.403") },
			404: { status: isHtml ? t("apiErrors:status.404") : rawError, solution: t("apiErrors:solution.404") },
			429: { status: rawError || t("apiErrors:status.429"), solution: t("apiErrors:solution.429") },
			500: { status: isHtml ? t("apiErrors:status.500") : rawError, solution: t("apiErrors:solution.500") },
			502: { status: isHtml ? t("apiErrors:status.502") : rawError, solution: t("apiErrors:solution.502") },
			503: { status: isHtml ? t("apiErrors:status.503") : rawError, solution: t("apiErrors:solution.503") },
			504: { status: isHtml ? t("apiErrors:status.504") : rawError, solution: t("apiErrors:solution.504") },
			undefined: {
				status: rawError || t("apiErrors:status.undefined"),
				solution: t("apiErrors:solution.undefined"),
			},
		} as Record<number | string, { status: string; solution: string }>
		const unauthorizedCodes = [
			"ai-gateway.unauthorized",
			"quota-manager.unauthorized",
			"quota-manager.token_invalid",
			"quota-manager.voucher_expired",
		]

		if (jsonBody) {
			const { code, message } = this.zgsmParse(jsonBody, rawError)
			let errmsg = t(code, { defaultValue: message })
			let solution = `\n\n${t("apiErrors:request.solution")}\n\n${unknownError.solution}`
			if (errmsg) {
				if (unauthorizedCodes.includes(code)) {
					rawError = errmsg
					error.status = status = 401
				} else if (
					[
						// "ai-gateway.star_required",
						"chat-rag.context_length_exceeded",
						"chat-rag.internal_error",
					].includes(code)
				) {
					solution = `\n\n${t("apiErrors:request.solution")}\n\n${t(`apiErrors:solution.${code}`)}`
					if (code === "chat-rag.internal_error") {
						error.status = status = 500
					} else if (code === "chat-rag.context_length_exceeded") {
						error.status = status = 429
					}
				} else if (code === "quota-check.insufficient_quota" || code === "ai-gateway.star_required") {
					let hash = await this.hashToken(this.apiConfiguration.zgsmApiKey || "")

					const isQuota = code === "quota-check.insufficient_quota"

					const solution1 = isQuota
						? t("apiErrors:solution.quota-check.insufficientCredits")
						: t("apiErrors:solution.ai-gateway.pleaseStarProject")
					const solution2 = isQuota
						? t("apiErrors:solution.quota-check.quotaAcquisition")
						: t("apiErrors:solution.ai-gateway.howToStar")

					solution = `\n\n
<span style="color:#E64545">${solution1}</span>  <mark hash=${hash} type="GUIDE">${solution2}</mark>

${t("apiErrors:solution.quota-check.checkRemainingQuota")} “ <mark hash=${hash} type="CREDIT">${t("apiErrors:solution.quota-check.creditUsageStats")}</mark> ” ${t("apiErrors:solution.quota-check.viewDetails")}
`
				}
				TelemetryService.instance.captureError(`ApiError_${code}`)
				this.providerRef
					.deref()
					?.log(`[Costrict#apiErrors] task ${taskId}.${instanceId} Raw Error: ${rawError}`)

				return `${t("apiErrors:request.error_details")}\n\n${errmsg}${solution}`
			}
		}

		const _err = defaultApiErrors[status] || unknownError
		if (defaultApiErrors[status]) {
			TelemetryService.instance.captureError(
				status === undefined ? `ApiError_unknown` : `ApiError_status_${status}`,
			)
		} else {
			TelemetryService.instance.captureError(`ApiError_unknown`)
		}
		this.providerRef.deref()?.log(`[Costrict#apiErrors] task ${taskId}.${instanceId} Raw Error: ${rawError}`)

		return `${t("apiErrors:request.error_details")}\n\n${_err.status}\n\n${t("apiErrors:request.solution")}\n\n${_err.solution}`
	}

	public zgsmParse(errStr: string, rawError: string) {
		try {
			const { message, code } = JSON.parse(errStr)
			this.providerRef
				.deref()
				?.log(
					`[Costrict#apiErrors] task ${this.taskId}.${this.instanceId} SerializeError Raw Failed: ${message || rawError}\n\n (todo code: ${code})`,
				)

			return { message, code }
		} catch (error) {
			console.warn("[zgsmParse]", error.message)

			return { message: "", code: "" }
		}
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++
		TelemetryService.instance.captureError(`ToolUsageError_${toolName}`)
		if (error) {
			this.emit("taskToolFailed", this.taskId, toolName, error)
		}
	}

	// Getters

	public get cwd() {
		return this.workspacePath
	}

	private async hashToken(token: string) {
		const encoder = new TextEncoder()
		const data = encoder.encode(token)
		const hashBuffer = await crypto.subtle.digest("SHA-256", data)
		return Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
	}
}
