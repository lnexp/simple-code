export { deepMerge } from './config/denylist.ts'
export { expandEnv } from './config/env.ts'
export type { LoadedConfig, LoadOptions, ModelRef } from './config/load.ts'
export {
  GLOBAL_CONFIG_PATH,
  listModels,
  loadConfig,
  selectModel,
  WORKSPACE_CONFIG_RELATIVE,
  writeWorkspaceSummaryInContext,
} from './config/load.ts'
export type {
  BashConfigShape,
  Config,
  ModelSpec,
  ProviderSpec,
  RequestPreferences,
} from './config/schema.ts'
export { configSchema } from './config/schema.ts'
export type { AgentEvent } from './events.ts'
export type { SendOptions } from './llm/client.ts'
export { sendRequest } from './llm/client.ts'
export type { LLMEvent, Reducer, SSEMessage } from './llm/events.ts'
export type {
  ErrorKind,
  Protocol,
  ProtocolError,
  ProtocolName,
  ProviderContext,
} from './llm/protocol.ts'
export { LLMStreamError } from './llm/protocol.ts'
export { PROTOCOL_NAMES, resolveProtocol } from './llm/registry.ts'
export type {
  Capabilities,
  Effort,
  FinishReason,
  ImageInput,
  ImagePart,
  Message,
  Part,
  ReasoningPart,
  Request,
  TextPart,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
  Usage,
} from './llm/types.ts'
export { hasPendingToolCalls, interruptedResult, normalizeHistory } from './loop/normalize.ts'
export { findBreak, fingerprint, PrefixBrokenError } from './loop/prefix-guard.ts'
export { regionsEstimate } from './loop/regions.ts'
export type { RetryConfig, StreamEvent } from './loop/retry.ts'
export { requestWithRetry } from './loop/retry.ts'
export type { LoopContext, LoopDeps, MemoryDeps, Task } from './loop/run.ts'
export { run } from './loop/run.ts'
export {
  estimateMessageTokens,
  estimateTokens,
  totalInputTokens,
  totalTokens,
} from './loop/tokens.ts'
export { unloadMessage } from './loop/unload.ts'
export { startCredentialProxy } from './proxy/credential-proxy.ts'
export { forwardBlock, forwardLine, LLM_PROXY_PORT } from './remote.ts'
export { logRun, runLogPath } from './runlog.ts'
export { openDbReadOnly } from './session/db.ts'
export type { SetTimer } from './session/idle.ts'
export { watchIdle } from './session/idle.ts'
export type { Lock } from './session/lock.ts'
export { acquireLock, LOCK_RELATIVE, LockHeldError } from './session/lock.ts'
export {
  computeMemoryStats,
  type LastReflect,
  type LibraryStat,
  type MemoryStats,
} from './session/memory-stats.ts'
export type { CompactResult, Session, SessionOptions } from './session/session.ts'
export {
  getSession,
  type HydratePart,
  type HydrateRow,
  MODEL_SWITCH_HEAD,
  modelSwitchNotice,
  toHydrateRows,
} from './session/session.ts'
export type { Store, TaskScope } from './session/store.ts'
export {
  type HistoryRow,
  lastRegionLine,
  MEMORY_RELATIVE,
  openStore,
  SegmentFullError,
} from './session/store.ts'
export {
  createTask,
  finalizeTask,
  flipTaskLive,
  lastTaskReply,
  listTaskManifests,
  postTaskResult,
  readTaskManifest,
  scopeOf,
  TASK_RESULT_HEAD,
  type TaskManifest,
  taskResultText,
  writeTaskManifest,
} from './session/task.ts'
export {
  TASK_PORT_ENV,
  TASK_TOKEN_ENV,
  TASK_TOKEN_HEADER,
  type TaskDispatchRequest,
  type TaskDispatchResponse,
  type TaskModelEntry,
  type TaskModelsRequest,
  type TaskModelsResponse,
  type TaskSendListEntry,
  type TaskSendListRequest,
  type TaskSendListResponse,
  type TaskSendRequest,
  type TaskSendResponse,
  type WakeRequest,
  type WakeResponse,
} from './session/task-endpoint.ts'
export type { EnsureShimsOptions, ShimEntry } from './shims.ts'
export { ensureDocCopy, ensureShims, probeNode, resolveNodeBin } from './shims.ts'
export type { PatchChunk, PatchHunk } from './tools/applypatch.ts'
export { applyPatch, parsePatch } from './tools/applypatch.ts'
export type { ApprovalCategory, ApprovalVerdict } from './tools/approval.ts'
export type { BashConfig } from './tools/bash.ts'
export { createBashTool } from './tools/bash.ts'
export type { BgProcessInfo } from './tools/bg.ts'
export { describeError } from './tools/describe.ts'
export {
  type LessonWriteInput,
  listLessons,
  parseStdinLessonInput,
  readLesson,
  searchLessons,
  slugifyLessonName,
  writeLesson,
} from './tools/lesson.ts'
export type {
  McpCallResult,
  McpServerConfig,
  McpServers,
  McpToolInfo,
} from './tools/mcp.ts'
export { callMcpTool, listMcpTools } from './tools/mcp.ts'
export { findMemoryRoot, runLog, runSearch, runShow } from './tools/memory.ts'
export {
  listNoteCards,
  listNotes,
  NOTES_INDEX_LIMIT,
  type NoteCard,
  type NoteMeta,
  readNote,
  searchNotes,
  writeNote,
} from './tools/note.ts'
export { listSkills, readSkill, searchSkills } from './tools/skill.ts'
export type { ApprovalAsk, RawSink, Tool, ToolContext, ToolOutput } from './tools/types.ts'
export { createViewImageTool } from './tools/viewimage.ts'
export type { WebfetchConfig } from './tools/webfetch.ts'
export { createWebfetchTool } from './tools/webfetch.ts'
export type { WebsearchConfig } from './tools/websearch.ts'
export { createWebsearchTool } from './tools/websearch.ts'
